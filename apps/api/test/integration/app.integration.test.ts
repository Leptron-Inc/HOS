import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  isLivenessResponse,
  isReadinessResponse,
  LIVENESS_PATH,
  READINESS_PATH,
} from '@hos/shared';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { createHttpApp } from '../../src/app.factory.js';
import { loadConfig, type AppConfig } from '../../src/config/app-config.js';
import { exportJWK, generateKeyPair } from 'jose';
import { PlatformServices } from '../../src/platform/platform-services.js';

// Requires the migrated throwaway database from global-setup.ts (fails, never skips, without it).
const hosDb = inject('hosDb');
const databaseUrl = hosDb.api;
// A trusted issuer with a throwaway public key: the health tests send no credentials.
const issuerKey = await exportJWK((await generateKeyPair('ES256')).publicKey);
const identityEnv = {
  SECLOG_DATABASE_URL: hosDb.seclog,
  HOS_CELL_ID: 'test-cell',
  HOS_IDENTITY_ISSUERS: JSON.stringify([
    {
      issuer: 'https://idp.test',
      audience: 'hos-cell',
      realm: 'hotel_employee',
      jwks: { keys: [issuerKey] },
    },
  ]),
};

/** Builds a test configuration whose pool reports a unique application_name. */
function testConfig(env: Record<string, string>): { config: AppConfig; applicationName: string } {
  const applicationName = `hos-api-test-${randomUUID().slice(0, 8)}`;
  const loaded = loadConfig({ NODE_ENV: 'test', PORT: '0', ...identityEnv, ...env });
  return {
    applicationName,
    config: { ...loaded, database: { ...loaded.database, applicationName } },
  };
}

async function start(config: AppConfig): Promise<{ app: INestApplication; baseUrl: string }> {
  const app = await createHttpApp(config, { logger: false });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

async function connectionsNamed(applicationName: string): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from pg_stat_activity where application_name like $1 || '-%'",
      [applicationName],
    );
    return Number(result.rows[0]?.count ?? '0');
  } finally {
    await client.end();
  }
}

describe('HOS API against a real PostgreSQL', () => {
  it('liveness answers 200 { status: "ok" }', async () => {
    const { config } = testConfig({ DATABASE_URL: databaseUrl });
    const { app, baseUrl } = await start(config);
    try {
      const response = await fetch(`${baseUrl}${LIVENESS_PATH}`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(isLivenessResponse(body)).toBe(true);
      expect(body).toEqual({ status: 'ok' });
      // The server framework is not advertised.
      expect(response.headers.has('x-powered-by')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('readiness answers 200 with only status and the database check', async () => {
    const { config } = testConfig({ DATABASE_URL: databaseUrl });
    const { app, baseUrl } = await start(config);
    try {
      const response = await fetch(`${baseUrl}${READINESS_PATH}`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(isReadinessResponse(body)).toBe(true);
      expect(body).toEqual({ status: 'ready', checks: { database: 'up' } });
    } finally {
      await app.close();
    }
  });

  it('closes every pooled database connection on shutdown', async () => {
    const { config, applicationName } = testConfig({ DATABASE_URL: databaseUrl });
    const { app, baseUrl } = await start(config);
    await fetch(`${baseUrl}${READINESS_PATH}`);
    expect(await connectionsNamed(applicationName)).toBeGreaterThan(0);

    // Test-only access to the composition root, to observe every pool from the client side.
    const services = app.get(PlatformServices);
    await app.close();
    // Client side: every pool has ended and holds no connections the moment close() returns.
    for (const pool of [services.runtimePool, services.seclogPool]) {
      expect(pool.ended).toBe(true);
      expect(pool.totalCount).toBe(0);
    }

    // Server side: PostgreSQL removes a backend from pg_stat_activity asynchronously after the
    // client disconnects, so allow a short, bounded window. A real leak never reaches zero.
    const deadline = Date.now() + 3000;
    let remaining = await connectionsNamed(applicationName);
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      remaining = await connectionsNamed(applicationName);
    }
    expect(remaining).toBe(0);
  });
});

describe('HOS API with PostgreSQL unavailable', () => {
  it('still starts; liveness is ok and readiness is 503 not_ready', async () => {
    const { config } = testConfig({
      // Port 1 on loopback: nothing listens there, so the connection is refused quickly.
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/unavailable',
      DB_CONNECT_TIMEOUT_MS: '1000',
      DB_HEALTH_TIMEOUT_MS: '1500',
    });
    const { app, baseUrl } = await start(config);
    try {
      expect((await fetch(`${baseUrl}${LIVENESS_PATH}`)).status).toBe(200);
      const response = await fetch(`${baseUrl}${READINESS_PATH}`);
      expect(response.status).toBe(503);
      const body: unknown = await response.json();
      expect(isReadinessResponse(body)).toBe(true);
      expect(body).toEqual({ status: 'not_ready', checks: { database: 'down' } });
      // Error responses do not advertise the server framework either.
      expect(response.headers.has('x-powered-by')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
