import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeDatabase } from '../../src/kernel/database/database-probe.js';

// A TCP server that accepts connections and never answers: simulates a network stall where
// PostgreSQL cannot be reached and no server-side timeout can help.
describe('probeDatabase with an unresponsive server', () => {
  let server: Server;
  const sockets = new Set<Socket>();
  let port = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns false at its deadline and leaves no connection in the pool', async () => {
    const pool = new pg.Pool({
      connectionString: `postgres://nobody@127.0.0.1:${port}/stalled`,
      // Much longer than the probe deadline, to prove the deadline is what bounds the probe.
      connectionTimeoutMillis: 1500,
      max: 2,
    });
    try {
      const started = performance.now();
      expect(await probeDatabase(pool, 300)).toBe(false);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1000);

      // Once the pending connection attempt gives up, nothing remains in the pool.
      await new Promise((resolve) => setTimeout(resolve, 1700));
      expect(pool.totalCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
