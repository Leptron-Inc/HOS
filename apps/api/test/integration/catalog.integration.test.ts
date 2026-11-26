import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import {
  MigrationError,
  runMigrations,
  SESSION_PREAMBLE,
} from '../../src/kernel/database/migration/migration-runner.js';
import { ALL_MANIFESTS } from '../../src/manifests.js';
import {
  createTestDatabase,
  dropTestDatabase,
  MIGRATIONS_DIRECTORY,
} from '../support/test-database.js';
import { asRole, sqlState } from '../support/kernel-fixtures.js';

const urls = inject('hosDb');
const HOS_SCHEMAS = "('app', 'hos_ctx', 'kernel', 'hos_migration', 'audit', 'eventing')";
/** Every role the HOS bootstrap creates (cluster revisions 0001 and 0002). */
const HOS_ROLES = [
  'hos_owner',
  'hos_app',
  'hos_api',
  'hos_worker',
  'hos_migrator',
  'hos_seclog_writer',
  'hos_lookup_tenant',
  'hos_lookup_identity',
  'hos_history_writer',
  'hos_history_reader',
  'hos_history_eraser',
  'hos_relay',
  'hos_monitor',
  'hos_lookup_integration',
];

/**
 * Policies allowed on tenant tables: the C-09 allowlist, plus the system-role policies of the
 * not-yet-written events and security/audit specifications (PROVISIONAL, listed explicitly).
 */
const POLICY_ALLOWLIST: Record<string, { cmd: string; roles: string[] }> = {
  tenant_isolation: { cmd: '*', roles: ['hos_app'] },
  kernel_lookup: {
    cmd: 'r',
    roles: ['hos_lookup_tenant', 'hos_lookup_identity', 'hos_lookup_integration'],
  },
  history_write: { cmd: 'a', roles: ['hos_history_writer'] },
  history_read_sensitive: { cmd: 'r', roles: ['hos_history_reader'] },
  history_erase_select: { cmd: 'r', roles: ['hos_history_eraser'] },
  history_erase: { cmd: 'w', roles: ['hos_history_eraser'] },
  relay_access: { cmd: '*', roles: ['hos_relay'] },
  monitor_read: { cmd: 'r', roles: ['hos_monitor'] },
};

describe('Catalog checks (H-MIG, H-FK-05, H-DEPT-03)', () => {
  it('H-MIG-01: every table with organization_id has row-level security enabled and forced', async () => {
    await asRole(urls.admin, async (c) => {
      const rows = await c.query(`
        SELECT c.oid::regclass AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'p')
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
      expect(rows.rows).toEqual([]);
    });
  });

  it('H-MIG-02 and H-DEPT-03: every tenant table has tenant_isolation; every policy is allowlisted; none uses department_id', async () => {
    await asRole(urls.admin, async (c) => {
      const missing = await c.query(`
        SELECT c.oid::regclass::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ${HOS_SCHEMAS} AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
           AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')`);
      expect(missing.rows).toEqual([]);
      const policies = await c.query<{
        t: string;
        name: string;
        cmd: string;
        roles: string[];
        qual: string | null;
        check: string | null;
      }>(`
        SELECT p.polrelid::regclass::text AS t, p.polname AS name, p.polcmd AS cmd,
               ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (p.polroles) ORDER BY 1)::text[] AS roles,
               pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS check
          FROM pg_policy p`);
      expect(policies.rows.length).toBeGreaterThan(10);
      for (const policy of policies.rows) {
        const allowed = POLICY_ALLOWLIST[policy.name];
        expect(allowed, `${policy.t}.${policy.name}`).toBeDefined();
        if (policy.name === 'tenant_isolation' && policy.t.endsWith('_history')) {
          expect(policy.cmd, policy.t).toBe('r');
        } else {
          expect(policy.cmd, `${policy.t}.${policy.name}`).toBe(allowed?.cmd);
        }
        expect(policy.roles.length).toBe(1);
        expect(allowed?.roles, `${policy.t}.${policy.name}`).toContain(policy.roles[0]);
        expect(`${policy.qual ?? ''} ${policy.check ?? ''}`).not.toMatch(/department_id/);
      }
    });
  });

  it('H-MIG-03: no superuser or BYPASSRLS role; runtime roles own nothing; nothing granted to PUBLIC; views are security_invoker', async () => {
    await asRole(urls.admin, async (c) => {
      // Exactly the roles the HOS bootstrap creates (a cluster administrator may share the prefix).
      const roles = await c.query(
        'SELECT rolname FROM pg_roles WHERE rolname = ANY ($1) AND (rolsuper OR rolbypassrls)',
        [HOS_ROLES],
      );
      const present = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1)',
        [HOS_ROLES],
      );
      expect(present.rows[0]?.n).toBe(HOS_ROLES.length);
      expect(roles.rows).toEqual([]);
      const owned = await c.query(`
        SELECT c.oid::regclass AS o FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ${HOS_SCHEMAS}
           AND pg_get_userbyid(c.relowner) IN ('hos_api', 'hos_worker', 'hos_migrator', 'hos_seclog_writer', 'hos_relay', 'hos_monitor', 'hos_app')`);
      expect(owned.rows).toEqual([]);
      const publicGrants = await c.query(`
        SELECT c.oid::regclass AS t, a.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
               aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         WHERE n.nspname IN ${HOS_SCHEMAS} AND a.grantee = 0`);
      expect(publicGrants.rows).toEqual([]);
      const schemaGrants = await c.query(`
        SELECT n.nspname FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
         WHERE (n.nspname IN ${HOS_SCHEMAS} OR n.nspname = 'public') AND a.grantee = 0`);
      expect(schemaGrants.rows).toEqual([]);
      const views = await c.query(`
        SELECT c.oid::regclass AS v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ${HOS_SCHEMAS} AND ((c.relkind = 'v' AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)) OR c.relkind = 'm')`);
      expect(views.rows).toEqual([]);
    });
  });

  it('H-MIG-08 and H-FK-05: foreign keys between tenant tables include the tenant columns and have a matching index', async () => {
    await asRole(urls.admin, async (c) => {
      const fks = await c.query<{
        name: string;
        child: string;
        parent: string;
        cols: string[];
        child_has_property: boolean;
        parent_has_property: boolean;
        indexed: boolean;
      }>(`
        SELECT con.conname AS name, con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
               ARRAY(SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = ANY (con.conkey))::text[] AS cols,
               EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = con.conrelid AND attname = 'property_id') AS child_has_property,
               EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = con.confrelid AND attname = 'property_id') AS parent_has_property,
               EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = con.conrelid
                         AND (i.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey
                         AND (i.indkey::int2[])[0:cardinality(con.conkey) - 1] <@ con.conkey) AS indexed
          FROM pg_constraint con JOIN pg_namespace n ON n.oid = (SELECT relnamespace FROM pg_class WHERE oid = con.conrelid)
         WHERE con.contype = 'f' AND n.nspname IN ${HOS_SCHEMAS}`);
      expect(fks.rows.length).toBeGreaterThan(5);
      for (const fk of fks.rows) {
        if (fk.parent.startsWith('app.ref_')) continue;
        expect(fk.cols, `${fk.child}.${fk.name}`).toContain('organization_id');
        expect(fk.indexed, `${fk.child}.${fk.name} has no matching index`).toBe(true);
      }
    });
  });

  it('H-MIG-08: every tenant index leads with organization_id, except primary keys and listed lookup indexes', async () => {
    const listed = new Set(
      ALL_MANIFESTS.flatMap((m) => m.tables.flatMap((t) => t.lookupIndexes ?? [])),
    );
    await asRole(urls.admin, async (c) => {
      const rows = await c.query<{ idx: string; first: string; pk: boolean; uniq: boolean }>(`
        SELECT ic.relname AS idx, a.attname AS first, i.indisprimary AS pk, i.indisunique AS uniq
          FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
         WHERE n.nspname IN ${HOS_SCHEMAS}
           AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'organization_id')`);
      const offenders = rows.rows.filter(
        (r) =>
          !r.pk &&
          r.first !== 'organization_id' &&
          !listed.has(r.idx) &&
          !(r.uniq && r.first === 'id'),
      );
      expect(offenders.map((o) => o.idx)).toEqual([]);
    });
  });

  it('H-MIG-09: role memberships follow the SET-only model; owner roles cannot log in', async () => {
    await asRole(urls.admin, async (c) => {
      const rows = await c.query<{
        member: string;
        role: string;
        inherit: boolean;
        set: boolean;
        admin: boolean;
      }>(`
        SELECT pg_get_userbyid(m.member) AS member, pg_get_userbyid(m.roleid) AS role,
               m.inherit_option AS inherit, m.set_option AS set, m.admin_option AS admin
          FROM pg_auth_members m WHERE pg_get_userbyid(m.roleid) LIKE 'hos\\_%' AND NOT m.admin_option`);
      const definerOwners = [
        'hos_owner',
        'hos_lookup_tenant',
        'hos_lookup_identity',
        'hos_lookup_integration',
        'hos_history_writer',
        'hos_history_reader',
        'hos_history_eraser',
      ];
      for (const row of rows.rows) {
        if (definerOwners.includes(row.role)) {
          expect(row.member, `${row.member} -> ${row.role}`).toBe('hos_migrator');
          expect(row.inherit).toBe(false);
          expect(row.set).toBe(true);
        } else {
          expect(row.role).toBe('hos_app');
          expect(['hos_api', 'hos_worker']).toContain(row.member);
        }
      }
      const logins = await c.query(
        `SELECT rolname FROM pg_roles WHERE rolname = ANY ($1) AND rolcanlogin`,
        [definerOwners.concat('hos_app')],
      );
      expect(logins.rows).toEqual([]);
    });
  });

  it('H-MIG-11: every object is owned by hos_owner, except allowlisted definer functions; hos_migrator owns nothing', async () => {
    await asRole(urls.admin, async (c) => {
      const tables = await c.query(`
        SELECT c.oid::regclass AS o, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ${HOS_SCHEMAS} AND pg_get_userbyid(c.relowner) <> 'hos_owner'`);
      expect(tables.rows).toEqual([]);
      const functions = await c.query(`
        SELECT p.oid::regprocedure AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ${HOS_SCHEMAS} AND NOT p.prosecdef AND pg_get_userbyid(p.proowner) <> 'hos_owner'`);
      expect(functions.rows).toEqual([]);
      const schemas = await c.query(
        `SELECT nspname FROM pg_namespace WHERE nspname IN ${HOS_SCHEMAS} AND pg_get_userbyid(nspowner) <> 'hos_owner'`,
      );
      expect(schemas.rows).toEqual([]);
    });
  });

  it('H-MIG-13: every history table has enabled capture_version, history_guard and history_no_truncate triggers', async () => {
    await asRole(urls.admin, async (c) => {
      const histories = (
        await c.query<{ t: string }>(`
        SELECT c.oid::regclass::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ${HOS_SCHEMAS} AND c.relkind = 'r' AND c.relname LIKE '%\\_history'`)
      ).rows.map((r) => r.t);
      expect(histories.length).toBeGreaterThanOrEqual(4);
      for (const history of histories) {
        const triggers = await c.query<{ tgname: string; tgenabled: string }>(
          `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
          [history],
        );
        const enabled = new Set(
          triggers.rows.filter((t) => t.tgenabled === 'O').map((t) => t.tgname),
        );
        expect(enabled.has('history_guard') && enabled.has('history_no_truncate'), history).toBe(
          true,
        );
        const base = history.replace(/_history$/, '');
        const capture = await c.query(
          `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = 'capture_version' AND tgenabled = 'O'`,
          [base],
        );
        expect(capture.rowCount, `${base} capture_version`).toBe(1);
      }
    });
  });

  it('H-MIG-10 and H-MIG-14: hos_migrator without SET ROLE has no privileges; the preamble refuses other roles', async () => {
    await asRole(urls.migrator, async (c) => {
      expect(await sqlState(c.query('CREATE TABLE app.should_fail (x int)'))).toBe('42501');
    });
    await asRole(urls.api, async (c) => {
      expect(await sqlState(c.query(SESSION_PREAMBLE))).not.toBeUndefined();
    });
  });

  it('H-MIG-12: hos_owner sees no tenant rows (why schema migrations contain no DML)', async () => {
    await asRole(urls.migrator, async (c) => {
      await c.query('SET ROLE hos_owner');
      const result = await c.query('UPDATE app.tenant_department SET name = name');
      expect(result.rowCount).toBe(0);
    });
  });

  it('H-TIME-06: every login role runs in UTC', async () => {
    for (const url of [
      urls.api,
      urls.worker,
      urls.migrator,
      urls.seclog,
      urls.relay,
      urls.monitor,
    ]) {
      await asRole(url, async (c) => {
        expect(
          (await c.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz")).rows[0]?.tz,
        ).toBe('UTC');
      });
    }
  });
});

describe('Manifests match the database (H-MIG-04, B-06, E-26)', () => {
  it('every table in the HOS schemas is claimed by exactly one manifest, and every column is classified', async () => {
    const claimed = new Map<string, string>();
    for (const manifest of ALL_MANIFESTS) {
      for (const table of manifest.tables) {
        for (const name of [table.table, table.history].filter(
          (t): t is string => t !== undefined,
        )) {
          expect(claimed.has(name), `${name} claimed twice`).toBe(false);
          claimed.set(name, manifest.module);
        }
        expect(Object.values(table.columns)).not.toContain('secret');
      }
    }
    await asRole(urls.admin, async (c) => {
      const tables = (
        await c.query<{ t: string }>(`
        SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('app', 'audit', 'eventing') AND c.relkind IN ('r', 'p')`)
      ).rows.map((r) => r.t);
      expect(tables.filter((t) => !claimed.has(t))).toEqual([]);
      expect([...claimed.keys()].filter((t) => !tables.includes(t))).toEqual([]);
      for (const manifest of ALL_MANIFESTS) {
        for (const table of manifest.tables) {
          const [schema, name] = table.table.split('.');
          const columns = (
            await c.query<{ column_name: string }>(
              'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
              [schema, name],
            )
          ).rows.map((r) => r.column_name);
          expect(
            columns.filter((col) => !(col in table.columns)),
            `${table.table} unclassified columns`,
          ).toEqual([]);
          expect(
            Object.keys(table.columns).filter((col) => !columns.includes(col)),
            `${table.table} stale columns`,
          ).toEqual([]);
          const hasOrg =
            columns.includes('organization_id') || table.table === 'app.tenant_organization';
          if (table.scope === 'organization' || table.scope === 'property')
            expect(hasOrg, table.table).toBe(true);
          if (table.scope === 'property')
            expect(
              columns.includes('property_id') || table.table === 'app.tenant_property',
              table.table,
            ).toBe(true);
        }
      }
    });
  });
});

describe('Migration runner safeguards (G-02, G-03, H-MIG-07)', () => {
  it('refuses an edited applied migration and an out-of-order migration', async () => {
    const scratch = await createTestDatabase('hos_mig');
    const dir = await mkdtemp(join(tmpdir(), 'hos-migrations-'));
    try {
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        await writeFile(join(dir, name), await readFile(join(MIGRATIONS_DIRECTORY, name), 'utf8'));
      }
      const first = (await readdir(dir)).sort()[0] ?? '';
      await writeFile(join(dir, first), `${await readFile(join(dir, first), 'utf8')}\n-- edited\n`);
      const options = {
        connectionString: scratch.migrator,
        directory: dir,
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 60_000,
      };
      await expect(runMigrations(options)).rejects.toThrow(/checksum mismatch/);
      await writeFile(join(dir, first), await readFile(join(MIGRATIONS_DIRECTORY, first), 'utf8'));
      await writeFile(join(dir, '20200101000000_tenant_too_old.sql'), 'SELECT 1;\n');
      await expect(runMigrations(options)).rejects.toThrow(/Out-of-order/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await dropTestDatabase(scratch.database);
    }
  });

  it('lint refusals stop the run before anything is applied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hos-migrations-'));
    try {
      await writeFile(
        join(dir, '20990101000000_tenant_bad.sql'),
        "INSERT INTO app.tenant_organization (id) VALUES ('x');\n",
      );
      await expect(
        runMigrations({
          connectionString: urls.migrator,
          directory: dir,
          lockTimeoutMs: 1_000,
          statementTimeoutMs: 1_000,
        }),
      ).rejects.toBeInstanceOf(MigrationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
