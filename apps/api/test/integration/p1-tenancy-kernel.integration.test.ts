import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type pg from 'pg';
import { createRequestContext } from '../../src/kernel/context/context-factory.js';
import { runWithContext } from '../../src/kernel/context/context-store.js';
import { ContextMissingError } from '../../src/kernel/context/request-context.js';
import {
  ForbiddenStatementError,
  NestedTransactionError,
  TableNotInManifestError,
  TenantDatabase,
  TenantLookup,
  type ModuleManifest,
} from '../../src/kernel/database/public.js';
import { uuidv7 } from '../../src/kernel/ids.js';
import {
  TENANCY_MANIFEST,
  type TenancyTables,
} from '../../src/modules/tenancy/tenancy.manifest.js';
import {
  asRole,
  context,
  createTenantFixture,
  pool,
  setContext,
  sqlState,
  type TenantFixture,
} from '../support/kernel-fixtures.js';

const urls = inject('hosDb');
let apiPool: pg.Pool;
let db: TenantDatabase;
let f: TenantFixture;

beforeAll(async () => {
  apiPool = pool(urls.api, 4);
  db = new TenantDatabase(apiPool, { lockTimeoutMs: 5_000 });
  f = await createTenantFixture(apiPool);
});
afterAll(async () => {
  await apiPool.end();
});

const count = async (client: pg.Client, sql: string, params: unknown[] = []) =>
  Number(
    (await client.query<{ n: string }>(`SELECT count(*)::int AS n FROM (${sql}) AS q`, params))
      .rows[0]?.n,
  );

describe('P1 tenant isolation through row-level security (H-ISO, H-PROP)', () => {
  it('H-ISO-01: an OrgA context sees only OrgA rows in every tenant table', async () => {
    await asRole(urls.api, async (c) => {
      await c.query('BEGIN');
      await setContext(c, f.orgA, 'all');
      expect(await count(c, 'SELECT 1 FROM app.tenant_organization')).toBe(1);
      expect(await count(c, 'SELECT 1 FROM app.tenant_property')).toBe(2);
      expect(await count(c, 'SELECT 1 FROM app.tenant_department')).toBe(3);
      expect(
        await count(c, 'SELECT 1 FROM app.tenant_department WHERE organization_id <> $1', [f.orgA]),
      ).toBe(0);
      expect(
        await count(c, 'SELECT 1 FROM app.tenant_department_history WHERE organization_id <> $1', [
          f.orgA,
        ]),
      ).toBe(0);
      await c.query('ROLLBACK');
    });
  });

  it('H-ISO-02 and H-ISO-03: writes for another tenant are rejected or affect nothing', async () => {
    await asRole(urls.api, async (c) => {
      await c.query('BEGIN');
      await setContext(c, f.orgA, 'all');
      const state = await sqlState(
        c.query(
          `INSERT INTO app.tenant_department (id, organization_id, property_id, code, name, status, created_by, updated_by)
           VALUES ($1, $2, $3, 'X', 'X', 'active', $4, $4)`,
          [uuidv7(), f.orgB, f.b1, f.fixtureActor],
        ),
      );
      expect(state).toBe('42501');
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await setContext(c, f.orgA, 'all');
      const updated = await c.query(
        `UPDATE app.tenant_department SET name = 'x', version = version + 1 WHERE id = $1`,
        [f.hkB1],
      );
      expect(updated.rowCount).toBe(0);
      await c.query('ROLLBACK');
    });
  });

  it('H-ISO-05: both organizations use department code HK without a uniqueness error', async () => {
    await asRole(urls.api, async (c) => {
      for (const org of [f.orgA, f.orgB]) {
        await c.query('BEGIN');
        await setContext(c, org, 'all');
        expect(
          await count(c, "SELECT 1 FROM app.tenant_department WHERE code = 'HK'"),
        ).toBeGreaterThan(0);
        await c.query('ROLLBACK');
      }
    });
  });

  it('H-PROP-02, 03 and 05: a listed scope [A1] sees and writes only A1', async () => {
    await asRole(urls.api, async (c) => {
      await c.query('BEGIN');
      await setContext(c, f.orgA, 'list', [f.a1]);
      expect(await count(c, 'SELECT 1 FROM app.tenant_department')).toBe(2);
      expect(await count(c, 'SELECT 1 FROM app.tenant_department WHERE id = $1', [f.hkA2])).toBe(0);
      const state = await sqlState(
        c.query(
          `INSERT INTO app.tenant_department (id, organization_id, property_id, code, name, status, created_by, updated_by)
           VALUES ($1, $2, $3, 'NEW', 'New', 'active', $4, $4)`,
          [uuidv7(), f.orgA, f.a2, f.fixtureActor],
        ),
      );
      expect(state).toBe('42501');
      await c.query('ROLLBACK');
    });
  });

  it('H-PROP-04: an organization-wide scope sees A1 and A2', async () => {
    const rows = await db.transactionFor<TenancyTables, string[]>(
      context(f.orgA, f.fixtureActor),
      TENANCY_MANIFEST,
      async (tx) =>
        (await tx.db.selectFrom('app.tenant_department').select('property_id').execute()).map(
          (r) => r.property_id,
        ),
    );
    expect(new Set(rows)).toEqual(new Set([f.a1, f.a2]));
  });
});

describe('P1 missing, forged and frozen context (H-CTX, C-13)', () => {
  it('H-CTX-01: a tenant query with no context fails with 42501', async () => {
    await asRole(urls.api, async (c) => {
      expect(await sqlState(c.query('SELECT * FROM app.tenant_department'))).toBe('42501');
    });
  });

  it('H-CTX-02: an incomplete context is refused before any database call', async () => {
    let connects = 0;
    const counting = {
      connect: () => {
        connects += 1;
        return Promise.reject(new Error('should not connect'));
      },
    } as unknown as pg.Pool;
    const strict = new TenantDatabase(counting, { lockTimeoutMs: 1000 });
    const broken = {
      ...context(f.orgA, f.fixtureActor),
      tenant: { organizationId: 'not-a-uuid', properties: { kind: 'all_in_organization' } },
    };
    await expect(
      strict.transactionFor(Object.freeze(broken) as never, TENANCY_MANIFEST, () =>
        Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(ContextMissingError);
    await expect(
      strict.transaction(TENANCY_MANIFEST, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(ContextMissingError);
    expect(connects).toBe(0);
  });

  it('H-CTX-11: the context is deep-frozen and cannot be changed', () => {
    const ctx = context(f.orgA, f.fixtureActor);
    expect(() => {
      (ctx.tenant as { organizationId: string }).organizationId = f.orgB;
    }).toThrow(TypeError);
    expect(ctx.tenant.organizationId).toBe(f.orgA);
  });

  it('a unit of work cannot switch to another context', async () => {
    const a = context(f.orgA, f.fixtureActor);
    const b = context(f.orgB, f.fixtureActor);
    await runWithContext(a, async () => {
      expect(() => runWithContext(b, () => Promise.resolve())).toThrow(ContextMissingError);
      await db.transaction<TenancyTables, void>(TENANCY_MANIFEST, (tx) => {
        expect(tx.context.tenant.organizationId).toBe(f.orgA);
        return Promise.resolve();
      });
    });
  });

  it('a context input with a non-cell realm is refused', () => {
    expect(() =>
      createRequestContext({
        entryPoint: 'api',
        actor: { id: uuidv7(), realm: 'leptron_employee' as never, kind: 'user' },
        organizationId: f.orgA,
        properties: { kind: 'all_in_organization' },
      }),
    ).toThrow(ContextMissingError);
  });
});

describe('P1 kernel enforcement of module boundaries (B-07, B-20, B-21, C-07)', () => {
  const foreign: ModuleManifest = { module: 'other', prefix: 'other_', tables: [] };

  it('B-07: a module cannot name a table outside its manifest', async () => {
    await expect(
      db.transactionFor<TenancyTables, unknown>(context(f.orgA, f.fixtureActor), foreign, (tx) =>
        tx.db.selectFrom('app.tenant_department').selectAll().execute(),
      ),
    ).rejects.toBeInstanceOf(TableNotInManifestError);
  });

  it('B-07: kernel-owned tables are not reachable through module queries', async () => {
    await expect(
      db.transactionFor<Record<string, Record<string, unknown>>, unknown>(
        context(f.orgA, f.fixtureActor),
        TENANCY_MANIFEST,
        (tx) =>
          tx.db
            .selectFrom('audit.audit_record' as never)
            .selectAll()
            .execute(),
      ),
    ).rejects.toBeInstanceOf(TableNotInManifestError);
  });

  it('B-21: a second tenant transaction cannot open while one is open', async () => {
    await expect(
      db.transactionFor(context(f.orgA, f.fixtureActor), TENANCY_MANIFEST, () =>
        db.transactionFor(context(f.orgA, f.fixtureActor), TENANCY_MANIFEST, () =>
          Promise.resolve(),
        ),
      ),
    ).rejects.toBeInstanceOf(NestedTransactionError);
  });

  it('C-07: module code cannot end the transaction or change the context', async () => {
    await expect(
      db.transactionFor<TenancyTables, unknown>(
        context(f.orgA, f.fixtureActor),
        TENANCY_MANIFEST,
        (tx) => tx.db.transaction().execute(() => Promise.resolve()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenStatementError);
  });
});

describe('P1 pre-tenant lookups and definer functions (H-LOOK, H-DEF)', () => {
  it('H-LOOK-01 and 02: status lookups without context; other-organization properties are not_found', async () => {
    const lookup = new TenantLookup(apiPool);
    expect(await lookup.organizationStatus(f.orgA)).toBe('active');
    expect(await lookup.propertyStatus(f.orgA, f.a1)).toBe('active');
    expect(await lookup.propertyStatus(f.orgB, f.a1)).toBe('not_found');
    expect(await lookup.organizationStatus(uuidv7())).toBe('not_found');
  });

  it('H-LOOK-03 and 04: lookup privileges do not leak to callers; owner roles cannot be assumed', async () => {
    await asRole(urls.api, async (c) => {
      expect(await sqlState(c.query('SELECT id FROM app.tenant_property'))).toBe('42501');
      for (const role of [
        'hos_lookup_tenant',
        'hos_lookup_identity',
        'hos_history_writer',
        'hos_owner',
        'hos_lookup_integration',
      ]) {
        expect(await sqlState(c.query(`SET ROLE ${role}`))).toBe('42501');
      }
    });
  });

  it('H-LOOK-07: runtime roles cannot create temporary or permanent objects', async () => {
    await asRole(urls.api, async (c) => {
      expect(await sqlState(c.query('CREATE TEMP TABLE t (x int)'))).toBe('42501');
      expect(await sqlState(c.query('CREATE TABLE app.t (x int)'))).toBe('42501');
      expect(
        await sqlState(
          c.query('CREATE FUNCTION kernel.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'),
        ),
      ).toBe('42501');
      expect(await sqlState(c.query('CREATE TABLE public.t (x int)'))).toBe('42501');
    });
  });

  it('H-DEF-01 to 05: every SECURITY DEFINER function is allowlisted, correctly owned and safe', async () => {
    await asRole(urls.admin, async (c) => {
      const rows = (
        await c.query<{
          name: string;
          owner: string;
          config: string[] | null;
          leak: boolean;
          src: string;
          lang: string;
          public_exec: boolean;
        }>(
          `SELECT n.nspname || '.' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
                  p.proleakproof AS leak, p.prosrc AS src, l.lanname AS lang,
                  (p.proacl IS NULL OR has_function_privilege('public', p.oid, 'EXECUTE')) AS public_exec
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
            WHERE n.nspname IN ('app', 'hos_ctx', 'kernel', 'hos_migration', 'audit', 'eventing') AND p.prosecdef`,
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(6);
      const expectedOwner = (name: string) =>
        /_capture_version$/.test(name)
          ? 'hos_history_writer'
          : /_history_sensitive$/.test(name)
            ? 'hos_history_reader'
            : /_erase_history$/.test(name)
              ? 'hos_history_eraser'
              : /^kernel\.(organization|property)_status$/.test(name)
                ? 'hos_lookup_tenant'
                : /^kernel\.(resolve_principal|list_memberships)$/.test(name)
                  ? 'hos_lookup_identity'
                  : /^kernel\.webhook_endpoint_lookup$/.test(name)
                    ? 'hos_lookup_integration'
                    : 'NOT_ALLOWLISTED';
      for (const row of rows) {
        expect(row.owner, row.name).toBe(expectedOwner(row.name));
        expect(row.config, row.name).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(row.leak, row.name).toBe(false);
        expect(row.public_exec, row.name).toBe(false);
        if (row.lang === 'plpgsql') expect(/\bEXECUTE\b/i.test(row.src), row.name).toBe(false);
      }
      const publicExecutable = await c.query(
        `SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('app', 'hos_ctx', 'kernel', 'hos_migration', 'audit', 'eventing')
            AND (p.proacl IS NULL OR has_function_privilege('public', p.oid, 'EXECUTE'))`,
      );
      expect(publicExecutable.rows).toEqual([]);
    });
  });
});

describe('P1 history protection (H-HIST)', () => {
  it('H-HIST-01: a department insert and two updates give three versions with actor and correlation', async () => {
    const id = uuidv7();
    const actor = uuidv7();
    const ctx = context(f.orgA, actor);
    await db.transactionFor<TenancyTables, void>(ctx, TENANCY_MANIFEST, async (tx) => {
      await tx.db
        .insertInto('app.tenant_department')
        .values({
          id,
          organization_id: f.orgA,
          property_id: f.a1,
          code: 'FO',
          name: 'Front office',
          status: 'active',
          created_by: actor,
          updated_by: actor,
        })
        .execute();
      for (const version of [1, 2]) {
        await tx.db
          .updateTable('app.tenant_department')
          .set({ name: `Front office v${version + 1}`, version: version + 1, updated_by: actor })
          .where('id', '=', id)
          .where('organization_id', '=', f.orgA)
          .where('version', '=', version)
          .execute();
      }
    });
    const history = await db.transactionFor<
      TenancyTables,
      { version: number; actor_id: string; correlation_id: string }[]
    >(ctx, TENANCY_MANIFEST, (tx) =>
      tx.db
        .selectFrom('app.tenant_department_history')
        .select(['version', 'actor_id', 'correlation_id'])
        .where('entity_id', '=', id)
        .orderBy('version')
        .execute(),
    );
    expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
    expect(
      history.every((h) => h.actor_id === actor && h.correlation_id === ctx.correlationId),
    ).toBe(true);
  });

  it('H-HIST-02 and 03: runtime roles cannot insert, update or delete history', async () => {
    await asRole(urls.api, async (c) => {
      await c.query('BEGIN');
      await setContext(c, f.orgA, 'all');
      expect(
        await sqlState(
          c.query(
            `INSERT INTO app.tenant_department_history (organization_id, property_id, entity_id, version, recorded_at, correlation_id, actor_id, code, name, status)
         VALUES ($1, $2, $3, 99, now(), $3, $3, 'X', 'X', 'active')`,
            [f.orgA, f.a1, uuidv7()],
          ),
        ),
      ).toBe('42501');
      await c.query('ROLLBACK');
      for (const sql of [
        "UPDATE app.tenant_department_history SET name = 'x'",
        'DELETE FROM app.tenant_department_history',
      ]) {
        await c.query('BEGIN');
        await setContext(c, f.orgA, 'all');
        expect(await sqlState(c.query(sql))).toBe('42501');
        await c.query('ROLLBACK');
      }
    });
  });

  it('H-HIST-04: an update that does not increment version fails (E-20)', async () => {
    await expect(
      db.transactionFor<TenancyTables, unknown>(
        context(f.orgA, f.fixtureActor),
        TENANCY_MANIFEST,
        (tx) =>
          tx.db
            .updateTable('app.tenant_department')
            .set({ name: 'same version' })
            .where('id', '=', f.mtA1)
            .execute(),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('H-HIST-13: runtime and migration roles cannot disable triggers or replication-role bypass', async () => {
    await asRole(urls.api, async (c) => {
      expect(await sqlState(c.query('SET session_replication_role = replica'))).toBe('42501');
      expect(
        await sqlState(
          c.query('ALTER TABLE app.tenant_department_history DISABLE TRIGGER history_guard'),
        ),
      ).toBe('42501');
      expect(
        await sqlState(c.query('DROP TRIGGER history_guard ON app.tenant_department_history')),
      ).toBe('42501');
    });
    await asRole(urls.migrator, async (c) => {
      expect(await sqlState(c.query('SET session_replication_role = replica'))).toBe('42501');
      await c.query('SET ROLE hos_owner');
      expect(await sqlState(c.query('SET session_replication_role = replica'))).toBe('42501');
    });
  });
});

describe('P1 connection-pool safety (H-POOL)', () => {
  it('H-POOL-01 and 02: no context survives commit or a failed transaction on a pool of one', async () => {
    const single = pool(urls.api, 1);
    const singleDb = new TenantDatabase(single, { lockTimeoutMs: 5_000 });
    try {
      await singleDb.transactionFor(context(f.orgA, f.fixtureActor), TENANCY_MANIFEST, () =>
        Promise.resolve(),
      );
      const after = await single.query<{ v: string | null }>(
        "SELECT current_setting('hos.organization_id', true) AS v",
      );
      expect(after.rows[0]?.v ?? '').toBe('');
      expect(await sqlState(single.query('SELECT 1 FROM app.tenant_department'))).toBe('42501');

      await expect(
        singleDb.transactionFor(context(f.orgA, f.fixtureActor), TENANCY_MANIFEST, () =>
          Promise.reject(new Error('mid-way failure')),
        ),
      ).rejects.toThrow('mid-way failure');
      const orgs = await singleDb.transactionFor<TenancyTables, string[]>(
        context(f.orgB, f.fixtureActor),
        TENANCY_MANIFEST,
        async (tx) =>
          (await tx.db.selectFrom('app.tenant_department').select('organization_id').execute()).map(
            (r) => r.organization_id,
          ),
      );
      expect(new Set(orgs)).toEqual(new Set([f.orgB]));
    } finally {
      await single.end();
    }
  });

  it('H-POOL-03: a connection whose ROLLBACK fails is destroyed, not reused', async () => {
    const single = pool(urls.api, 1);
    const singleDb = new TenantDatabase(single, { lockTimeoutMs: 5_000 });
    try {
      await expect(
        singleDb.transactionFor<TenancyTables, void>(
          context(f.orgA, f.fixtureActor),
          TENANCY_MANIFEST,
          async (tx) => {
            const pid = await tx.db
              .selectFrom('app.tenant_organization')
              .select((eb) => eb.fn<number>('pg_backend_pid').as('pid'))
              .executeTakeFirstOrThrow();
            // Terminate our own backend from another session: COMMIT and ROLLBACK both fail.
            await asRole(urls.admin, (c) => c.query('SELECT pg_terminate_backend($1)', [pid.pid]));
            throw new Error('work failed after the connection broke');
          },
        ),
      ).rejects.toThrow('work failed after the connection broke');
      expect(single.totalCount).toBe(0);
      // The pool recovers with a fresh connection.
      await singleDb.transactionFor(context(f.orgA, f.fixtureActor), TENANCY_MANIFEST, () =>
        Promise.resolve(),
      );
    } finally {
      await single.end();
    }
  });

  it('H-POOL-04: parallel units of work over a small pool never see another tenant', async () => {
    const small = pool(urls.api, 3);
    const smallDb = new TenantDatabase(small, { lockTimeoutMs: 5_000 });
    try {
      const runs = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? f.orgA : f.orgB));
      const results = await Promise.all(
        runs.map((org) =>
          smallDb
            .transactionFor<TenancyTables, string[]>(
              context(org, f.fixtureActor),
              TENANCY_MANIFEST,
              async (tx) =>
                (
                  await tx.db
                    .selectFrom('app.tenant_department')
                    .select('organization_id')
                    .execute()
                ).map((r) => r.organization_id),
            )
            .then((orgs) => ({ org, orgs })),
        ),
      );
      for (const { org, orgs } of results) expect(orgs.every((o) => o === org)).toBe(true);
    } finally {
      await small.end();
    }
  });
});
