import { AsyncLocalStorage } from 'node:async_hooks';
import { Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import { currentContext } from '../context/context-store.js';
import { ContextMissingError, type RequestContext } from '../context/request-context.js';
import { isUuid } from '../ids.js';
import { tableSet, type ModuleManifest } from './manifest.js';
import { ManifestPlugin } from './manifest-plugin.js';

/**
 * The tenant transaction (tenancy specification C-06, C-07, C-13, C-15, B-07, B-20 to B-22, B-24).
 * Every access to a tenant table happens inside one, opened only here.
 */
export interface TenantTx<DB> {
  /** Query builder restricted to the calling module's manifest (B-07). */
  readonly db: Kysely<DB>;
  readonly context: RequestContext;
  readonly module: string;
}

/** Kernel-only access to the transaction's connection, for the L1 kernel writers (B-07 exceptions). */
export const KERNEL_CONNECTION: unique symbol = Symbol('hos.kernel.connection');
export interface KernelTenantTx {
  readonly [KERNEL_CONNECTION]: pg.PoolClient;
}

export class NestedTransactionError extends Error {
  constructor(open: string, requested: string) {
    super(
      `Module ${requested} cannot open a tenant transaction while ${open}'s is open: cross-module ` +
        'writes follow the recoverable-sequence model (B-20, B-21).',
    );
    this.name = 'NestedTransactionError';
  }
}

export class ForbiddenStatementError extends Error {
  constructor(reason: string) {
    super(`Statement refused inside a tenant transaction: ${reason}`);
    this.name = 'ForbiddenStatementError';
  }
}

const openTransaction = new AsyncLocalStorage<{ readonly module: string }>();

/** Throws (fail closed, C-13, H-CTX-02) before any database call if the context is incomplete. */
export function assertCompleteContext(
  ctx: RequestContext | undefined,
): asserts ctx is RequestContext {
  if (ctx === undefined) throw new ContextMissingError('no context');
  if (!Object.isFrozen(ctx)) throw new ContextMissingError('context is not frozen');
  if (!isUuid(ctx.tenant?.organizationId)) throw new ContextMissingError('organization');
  if (!isUuid(ctx.actor?.id)) throw new ContextMissingError('actor');
  if (!['hotel_employee', 'guest', 'machine'].includes(ctx.actor.realm))
    throw new ContextMissingError('actor realm');
  if (!isUuid(ctx.correlationId)) throw new ContextMissingError('correlation');
  const scope = ctx.tenant.properties;
  if (scope?.kind !== 'all_in_organization' && scope?.kind !== 'listed')
    throw new ContextMissingError('property scope');
  if (scope.kind === 'listed' && !scope.propertyIds.every((id) => isUuid(id))) {
    throw new ContextMissingError('property scope list');
  }
}

/** PostgreSQL array literal of property UUIDs; '{}' when the scope is 'all' (spec §3.2). */
function propertyArray(ctx: RequestContext): string {
  const scope = ctx.tenant.properties;
  return scope.kind === 'all_in_organization' ? '{}' : `{${scope.propertyIds.join(',')}}`;
}

const TRANSACTION_CONTROL =
  /^\s*(begin|commit|rollback|end|abort|start\s+transaction|savepoint|release|prepare\s+transaction)\b/i;
const CONTEXT_CHANGE =
  /\bset_config\b|\bset\s+(local\s+|session\s+)?(hos\.|role\b|session\s+authorization)|\breset\b/i;

/** Wraps the connection so module queries can't end the transaction or change the context. */
function guardedClient(client: pg.PoolClient): pg.PoolClient {
  const query = ((text: unknown, ...rest: unknown[]) => {
    const sql = typeof text === 'string' ? text : ((text as { text?: string }).text ?? '');
    if (TRANSACTION_CONTROL.test(sql))
      throw new ForbiddenStatementError('transaction control belongs to the kernel');
    if (CONTEXT_CHANGE.test(sql))
      throw new ForbiddenStatementError('only the kernel sets the tenant context (C-07)');
    return (client.query as (...args: unknown[]) => unknown)(text, ...rest);
  }) as pg.PoolClient['query'];
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') return query;
      if (property === 'release') return () => undefined; // the kernel releases the connection
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function singleConnectionKysely<DB>(client: pg.PoolClient, manifest: ModuleManifest): Kysely<DB> {
  const guarded = guardedClient(client);
  const pool = {
    connect: () => Promise.resolve(guarded),
    end: () => Promise.resolve(),
  } as unknown as pg.Pool;
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new ManifestPlugin(manifest.module, tableSet(manifest))],
  });
}

export interface TenantDatabaseOptions {
  /** `lock_timeout` for each tenant transaction (F-21, configurable). */
  readonly lockTimeoutMs: number;
}

/** Opens tenant transactions on one runtime pool (hos_api in the API, hos_worker in workers). */
export class TenantDatabase {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: TenantDatabaseOptions,
  ) {}

  /** Runs `work` in a tenant transaction for the current unit of work's context (CX-02). */
  async transaction<DB, T>(
    manifest: ModuleManifest,
    work: (tx: TenantTx<DB>) => Promise<T>,
  ): Promise<T> {
    return this.transactionFor(currentContext(), manifest, work);
  }

  async transactionFor<DB, T>(
    ctx: RequestContext,
    manifest: ModuleManifest,
    work: (tx: TenantTx<DB>) => Promise<T>,
  ): Promise<T> {
    assertCompleteContext(ctx);
    const open = openTransaction.getStore();
    if (open !== undefined) throw new NestedTransactionError(open.module, manifest.module);

    const client = await this.pool.connect();
    let broken: Error | undefined;
    // A connection that fails while checked out emits 'error' on the client; the pool listens only
    // on idle clients, so without this listener the process would crash. Mark it broken instead.
    const onClientError = (error: Error) => {
      broken = error;
    };
    client.on('error', onClientError);
    try {
      await client.query('BEGIN');
      // C-06, C-07: the first statement after BEGIN, transaction-local, values from the context only.
      await client.query(
        `SELECT set_config('hos.organization_id', $1, true),
                set_config('hos.property_scope',  $2, true),
                set_config('hos.property_ids',    $3, true),
                set_config('hos.actor_id',        $4, true),
                set_config('hos.actor_realm',     $5, true),
                set_config('hos.correlation_id',  $6, true),
                set_config('lock_timeout',        $7, true)`,
        [
          ctx.tenant.organizationId,
          ctx.tenant.properties.kind === 'all_in_organization' ? 'all' : 'list',
          propertyArray(ctx),
          ctx.actor.id,
          ctx.actor.realm,
          ctx.correlationId,
          `${this.options.lockTimeoutMs}ms`,
        ],
      );
      const tx: TenantTx<DB> & KernelTenantTx = {
        db: singleConnectionKysely<DB>(client, manifest),
        context: ctx,
        module: manifest.module,
        [KERNEL_CONNECTION]: client,
      };
      const result = await openTransaction.run({ module: manifest.module }, () => work(tx));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // C-15, H-POOL-03: never return a broken connection to the pool.
        broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
      }
      throw error;
    } finally {
      client.off('error', onClientError);
      client.release(broken);
    }
  }
}

/** For L1 kernel writers only: the connection of an open tenant transaction. */
export function kernelConnection<DB>(tx: TenantTx<DB>): pg.PoolClient {
  const connection = (tx as Partial<KernelTenantTx>)[KERNEL_CONNECTION];
  if (connection === undefined) throw new ContextMissingError('not a kernel tenant transaction');
  return connection;
}
