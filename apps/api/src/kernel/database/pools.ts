import pg from 'pg';

/**
 * PostgreSQL pools, one per login role (tenancy specification §3.1). Each process opens only the
 * pools it needs: the API uses hos_api and hos_seclog_writer; workers use hos_worker, hos_relay
 * and hos_seclog_writer; the integrity monitor uses hos_monitor.
 *
 * Every connection gets a server-side statement_timeout (protective safeguard). The pool runs in
 * transaction mode only (C-15): tenant settings are transaction-local, so a returned connection
 * never carries a tenant.
 */
export interface PoolOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
  readonly onError: (error: Error) => void;
}

const INT8_OID = 20;

/** bigint columns (versions, counts) as numbers, refusing values beyond 2^53 instead of rounding. */
function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new RangeError('bigint value exceeds the safe integer range');
  return parsed;
}

const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID && (format === undefined || format === 'text')) return parseInt8;
    // numeric stays a string (E-06: amounts are never JavaScript numbers).
    return pg.types.getTypeParser(oid, format) as (value: string) => unknown;
  },
};

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: options.connectTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    application_name: options.applicationName,
    keepAlive: true,
    types: typeParsers,
  });
  pool.on('error', options.onError);
  return pool;
}

export async function endPool(pool: pg.Pool): Promise<void> {
  if (!pool.ended) await pool.end();
}
