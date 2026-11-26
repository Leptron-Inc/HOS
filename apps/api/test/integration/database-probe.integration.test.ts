import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPool, endPool } from '../../src/kernel/database/pools.js';
import { probeDatabase } from '../../src/kernel/database/database-probe.js';

// Requires the migrated throwaway database from global-setup.ts (fails, never skips, without it).
const hosDb = inject('hosDb');
// The administrator: these tests create and alter a scratch database.
const databaseUrl = hosDb.admin;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function createDatabase(url: string, applicationName: string) {
  return {
    pool: createPool({
      connectionString: url,
      max: 4,
      connectTimeoutMs: 2000,
      statementTimeoutMs: 30000,
      applicationName,
      onError: () => undefined,
    }),
  };
}

const closeDatabase = (handle: { pool: pg.Pool }) => endPool(handle.pool);

describe('probeDatabase against a real PostgreSQL', () => {
  it('cancels a slow statement server-side and leaves no running query or busy connection', async () => {
    const applicationName = `hos-probe-slow-${randomUUID().slice(0, 8)}`;
    const handle = createDatabase(databaseUrl, applicationName);
    try {
      const started = performance.now();
      // pg_sleep(5) stands in for a statement that hangs; the probe deadline is 300 ms.
      expect(await probeDatabase(handle.pool, 300, 'select pg_sleep(5)')).toBe(false);
      expect(performance.now() - started).toBeLessThan(1500);

      await sleep(300);
      const active = await admin((client) =>
        client.query<{ count: string }>(
          "select count(*)::text as count from pg_stat_activity where application_name = $1 and state = 'active'",
          [applicationName],
        ),
      );
      expect(Number(active.rows[0]?.count)).toBe(0);
      // The probe's connection was destroyed, not returned to the pool.
      expect(handle.pool.totalCount).toBe(0);

      // The pool is still usable afterwards.
      expect(await probeDatabase(handle.pool, 1000)).toBe(true);
      expect(handle.pool.idleCount).toBe(1);
    } finally {
      await closeDatabase(handle);
    }
  });

  describe('database failure and recovery', () => {
    const scratchDatabase = `hos_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let scratchUrl = '';

    beforeAll(async () => {
      await admin((client) => client.query(`create database ${scratchDatabase}`));
      const url = new URL(databaseUrl);
      url.pathname = `/${scratchDatabase}`;
      scratchUrl = url.toString();
    });

    afterAll(async () => {
      await admin(async (client) => {
        await client.query(`alter database ${scratchDatabase} allow_connections true`);
        await client.query(`drop database if exists ${scratchDatabase} with (force)`);
      });
    });

    it('reports down while connections are refused and up again after recovery', async () => {
      const handle = createDatabase(scratchUrl, `hos-probe-recovery-${randomUUID().slice(0, 8)}`);
      try {
        expect(await probeDatabase(handle.pool, 1000)).toBe(true);

        // Failure: the database stops accepting connections and existing sessions are ended.
        await admin(async (client) => {
          await client.query(`alter database ${scratchDatabase} allow_connections false`);
          await client.query(
            'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
            [scratchDatabase],
          );
        });
        await sleep(200);
        expect(await probeDatabase(handle.pool, 1000)).toBe(false);

        // Recovery: connections are allowed again; the same pool recovers without a restart.
        await admin((client) =>
          client.query(`alter database ${scratchDatabase} allow_connections true`),
        );
        expect(await probeDatabase(handle.pool, 1000)).toBe(true);
      } finally {
        await closeDatabase(handle);
      }
    });
  });
});
