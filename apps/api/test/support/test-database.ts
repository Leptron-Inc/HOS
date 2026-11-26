import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyBootstrap } from '../../src/kernel/database/migration/bootstrap.js';
import { runMigrations } from '../../src/kernel/database/migration/migration-runner.js';

/**
 * Disposable test databases. HOS_TEST_ADMIN_URL points at a THROWAWAY PostgreSQL cluster whose
 * administrator may create databases and roles (a superuser, or a CREATEROLE + CREATEDB role as on
 * RDS). The HOS login roles have no passwords here: the throwaway cluster trusts local connections.
 */
export const BOOTSTRAP_DIRECTORY = fileURLToPath(new URL('../../db/bootstrap/', import.meta.url));
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export interface TestDatabaseUrls {
  readonly database: string;
  readonly admin: string;
  readonly api: string;
  readonly worker: string;
  readonly migrator: string;
  readonly seclog: string;
  readonly relay: string;
  readonly monitor: string;
}

export function adminUrlFromEnv(): string {
  const url = process.env.HOS_TEST_ADMIN_URL?.trim() ?? '';
  if (url === '') {
    throw new Error(
      'Integration tests require HOS_TEST_ADMIN_URL (administrator of a throwaway PostgreSQL cluster).',
    );
  }
  return url;
}

export function urlFor(base: string, user: string, database: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = '';
  url.pathname = `/${database}`;
  return url.toString();
}

export async function createTestDatabase(prefix = 'hos_it'): Promise<TestDatabaseUrls> {
  const admin = adminUrlFromEnv();
  const database = `${prefix}_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${database}`);
  } finally {
    await client.end();
  }
  const urls: TestDatabaseUrls = {
    database,
    admin: urlFor(admin, new URL(admin).username, database),
    api: urlFor(admin, 'hos_api', database),
    worker: urlFor(admin, 'hos_worker', database),
    migrator: urlFor(admin, 'hos_migrator', database),
    seclog: urlFor(admin, 'hos_seclog_writer', database),
    relay: urlFor(admin, 'hos_relay', database),
    monitor: urlFor(admin, 'hos_monitor', database),
  };
  await applyBootstrap(urls.admin, BOOTSTRAP_DIRECTORY);
  await runMigrations({
    connectionString: urls.migrator,
    directory: MIGRATIONS_DIRECTORY,
    lockTimeoutMs: 5_000,
    statementTimeoutMs: 120_000,
  });
  return urls;
}

export async function dropTestDatabase(database: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrlFromEnv() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
