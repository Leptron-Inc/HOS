import pg from 'pg';
import {
  createRequestContext,
  type ContextInput,
} from '../../src/kernel/context/context-factory.js';
import type { RequestContext } from '../../src/kernel/context/request-context.js';
import { createPool } from '../../src/kernel/database/pools.js';
import { TenantDatabase } from '../../src/kernel/database/public.js';
import { uuidv7 } from '../../src/kernel/ids.js';
import {
  TENANCY_MANIFEST,
  type TenancyTables,
} from '../../src/modules/tenancy/tenancy.manifest.js';

/** Fixture identifiers (spec §8: OrgA with A1 and A2, OrgB with B1). Test data only. */
export interface TenantFixture {
  readonly orgA: string;
  readonly orgB: string;
  readonly a1: string;
  readonly a2: string;
  readonly b1: string;
  readonly hkA1: string;
  readonly mtA1: string;
  readonly hkA2: string;
  readonly hkB1: string;
  readonly fixtureActor: string;
}

export function pool(url: string, max = 4): pg.Pool {
  return createPool({
    connectionString: url,
    max,
    connectTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    applicationName: 'hos-test',
    onError: () => undefined,
  });
}

export function context(
  organizationId: string,
  actorId: string,
  properties: ContextInput['properties'] = { kind: 'all_in_organization' },
  overrides: Partial<ContextInput> = {},
): RequestContext {
  return createRequestContext({
    entryPoint: 'provisioning',
    actor: { id: actorId, realm: 'machine', kind: 'service_identity' },
    organizationId,
    properties,
    ...overrides,
  });
}

/** Creates two organizations with properties and departments through the real kernel (hos_api). */
export async function createTenantFixture(apiPool: pg.Pool): Promise<TenantFixture> {
  const db = new TenantDatabase(apiPool, { lockTimeoutMs: 5_000 });
  const f: TenantFixture = {
    orgA: uuidv7(),
    orgB: uuidv7(),
    a1: uuidv7(),
    a2: uuidv7(),
    b1: uuidv7(),
    hkA1: uuidv7(),
    mtA1: uuidv7(),
    hkA2: uuidv7(),
    hkB1: uuidv7(),
    fixtureActor: uuidv7(),
  };
  const seed = async (
    org: string,
    properties: { id: string; departments: { id: string; code: string }[] }[],
  ) => {
    await db.transactionFor<TenancyTables, void>(
      context(org, f.fixtureActor),
      TENANCY_MANIFEST,
      async (tx) => {
        await tx.db
          .insertInto('app.tenant_organization')
          .values({
            id: org,
            display_name: `Org ${org.slice(0, 8)}`,
            status: 'active',
            created_by: f.fixtureActor,
            updated_by: f.fixtureActor,
          })
          .execute();
        for (const property of properties) {
          await tx.db
            .insertInto('app.tenant_property')
            .values({
              id: property.id,
              organization_id: org,
              display_name: 'Property',
              status: 'active',
              created_by: f.fixtureActor,
              updated_by: f.fixtureActor,
            })
            .execute();
          for (const department of property.departments) {
            await tx.db
              .insertInto('app.tenant_department')
              .values({
                id: department.id,
                organization_id: org,
                property_id: property.id,
                code: department.code,
                name: department.code,
                status: 'active',
                created_by: f.fixtureActor,
                updated_by: f.fixtureActor,
              })
              .execute();
          }
        }
      },
    );
  };
  await seed(f.orgA, [
    {
      id: f.a1,
      departments: [
        { id: f.hkA1, code: 'HK' },
        { id: f.mtA1, code: 'MT' },
      ],
    },
    { id: f.a2, departments: [{ id: f.hkA2, code: 'HK' }] },
  ]);
  await seed(f.orgB, [{ id: f.b1, departments: [{ id: f.hkB1, code: 'HK' }] }]);
  return f;
}

/** A transaction on a raw connection as a given login role, with the context set like the kernel. */
export async function asRole<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function setContext(
  client: pg.Client,
  org: string,
  scope: 'all' | 'list',
  ids: string[] = [],
  actor = uuidv7(),
): Promise<void> {
  await client.query(
    `SELECT set_config('hos.organization_id', $1, true), set_config('hos.property_scope', $2, true),
            set_config('hos.property_ids', $3, true), set_config('hos.actor_id', $4, true),
            set_config('hos.actor_realm', 'machine', true), set_config('hos.correlation_id', $5, true)`,
    [org, scope, `{${ids.join(',')}}`, actor, uuidv7()],
  );
}

export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
}
