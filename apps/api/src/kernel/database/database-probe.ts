import type pg from 'pg';

/**
 * Checks that PostgreSQL accepts a connection and answers a statement, within `timeoutMs`.
 * Never throws. Guarantees that a failed or timed-out probe never returns a busy connection to
 * the pool:
 *
 * - The statement runs in its own transaction with `SET LOCAL statement_timeout`, so PostgreSQL
 *   cancels it server-side after `timeoutMs`.
 * - If the probe fails or the overall deadline passes (for example a network stall where the
 *   server cannot be reached), the connection is released with an error, which makes pg-pool
 *   destroy it instead of reusing it. A connection that arrives after the deadline is destroyed
 *   the same way.
 *
 * `probeSql` exists so tests can simulate a slow database; production always uses `select 1`.
 */
export async function probeDatabase(
  pool: pg.Pool,
  timeoutMs: number,
  probeSql = 'select 1',
): Promise<boolean> {
  let deadlinePassed = false;
  let client: pg.PoolClient | undefined;
  let timer: NodeJS.Timeout | undefined;

  const destroyClient = (): void => {
    if (client !== undefined) {
      client.release(new Error('database probe did not complete'));
      client = undefined;
    }
  };

  const attempt = async (): Promise<boolean> => {
    const connected = await pool.connect();
    if (deadlinePassed) {
      connected.release(new Error('database probe connection arrived after the deadline'));
      return false;
    }
    client = connected;
    await connected.query('begin');
    await connected.query("select set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    await connected.query(probeSql);
    await connected.query('commit');
    return true;
  };

  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    const ok = await Promise.race([attempt().catch(() => false), deadline]);
    if (ok && client !== undefined) {
      client.release();
      client = undefined;
    }
    return ok;
  } finally {
    deadlinePassed = true;
    if (timer !== undefined) clearTimeout(timer);
    destroyClient();
  }
}
