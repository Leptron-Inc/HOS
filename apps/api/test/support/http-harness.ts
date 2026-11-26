import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import pg from 'pg';
import { createHttpApp } from '../../src/app.factory.js';
import { loadConfig, type AppConfig } from '../../src/config/app-config.js';
import { uuidv7 } from '../../src/kernel/ids.js';
import type { TestDatabaseUrls } from './test-database.js';

/**
 * End-to-end HTTP harness: the real application against the migrated throwaway database, with
 * test-only token issuers whose keys are generated per run (no external identity provider).
 */
export const STAFF_ISSUER = 'https://idp.test/staff';
export const GUEST_ISSUER = 'https://idp.test/guests';
export const MACHINE_ISSUER = 'https://idp.test/machines';
export const AUDIENCE = 'hos-cell-test';
export const PROVISIONING_SUBJECT = 'control-plane-provisioning';

export interface Issuer {
  readonly issuer: string;
  readonly realm: 'hotel_employee' | 'guest' | 'machine';
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, unknown>;
}

export async function createIssuer(issuer: string, realm: Issuer['realm']): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  return {
    issuer,
    realm,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' },
  };
}

export async function token(
  issuer: Issuer,
  subject: string,
  options: {
    expiresIn?: string;
    issuedAt?: number;
    claims?: Record<string, unknown>;
    audience?: string;
  } = {},
): Promise<string> {
  const jwt = new SignJWT({ ...(options.claims ?? {}) })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(issuer.issuer)
    .setSubject(subject)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? '5m');
  jwt.setIssuedAt(options.issuedAt ?? Math.floor(Date.now() / 1000));
  return jwt.sign(issuer.privateKey);
}

export interface Harness {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly config: AppConfig;
  readonly staff: Issuer;
  readonly guests: Issuer;
  readonly machines: Issuer;
  close(): Promise<void>;
}

export async function startHarness(
  urls: TestDatabaseUrls,
  env: Record<string, string> = {},
): Promise<Harness> {
  const staff = await createIssuer(STAFF_ISSUER, 'hotel_employee');
  const guests = await createIssuer(GUEST_ISSUER, 'guest');
  const machines = await createIssuer(MACHINE_ISSUER, 'machine');
  const storageRoot = mkdtempSync(join(tmpdir(), 'hos-storage-'));
  const config = loadConfig({
    HOS_LOCAL_SECRETS_DIR: join(storageRoot, 'secrets'),
    HOS_LOCAL_SECRETS_KEY: randomBytes(32).toString('base64'),
    HOS_DOCUMENT_STORAGE_DIR: join(storageRoot, 'documents'),
    HOS_DOCUMENT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    INTEGRATION_ALLOW_INSECURE_HTTP: 'true',
    NODE_ENV: 'test',
    PORT: '0',
    DATABASE_URL: urls.api,
    SECLOG_DATABASE_URL: urls.seclog,
    HOS_CELL_ID: 'test-cell',
    LOG_LEVEL: 'error',
    SECLOG_AGGREGATION_WINDOW_MS: '200',
    IAM_GRANTS_CACHE_TTL_MS: '0',
    HOS_IDENTITY_ISSUERS: JSON.stringify(
      [staff, guests, machines].map((i) => ({
        issuer: i.issuer,
        audience: AUDIENCE,
        realm: i.realm,
        jwks: { keys: [i.publicJwk] },
      })),
    ),
    HOS_PROVISIONING_ISSUER: MACHINE_ISSUER,
    HOS_PROVISIONING_SUBJECT: PROVISIONING_SUBJECT,
    ...env,
  });
  const app = await createHttpApp(config, { logger: false });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    staff,
    guests,
    machines,
    close: async () => {
      await app.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

export interface CallResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export async function call<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    idempotencyKey?: string | null;
  } = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && options.idempotencyKey !== null)
    headers['idempotency-key'] = options.idempotencyKey ?? uuidv7();
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as T,
    headers: response.headers,
  };
}

/** Provisions an organization with properties and accepts its first-administrator invitation. */
export async function provisionTenant(
  harness: Harness,
  properties: readonly string[],
  adminSubject: string,
): Promise<{ organizationId: string; adminToken: string }> {
  const organizationId = uuidv7();
  const provisioning = await token(harness.machines, PROVISIONING_SUBJECT);
  const created = await call<{ first_administrator_invitation: { token: string } | null }>(
    harness,
    'PUT',
    `/v1/provisioning/organizations/${organizationId}`,
    {
      token: provisioning,
      body: {
        display_name: `Org ${organizationId.slice(-6)}`,
        first_administrator: { display_name: 'First Admin' },
      },
    },
  );
  if (created.status !== 201 || created.body.first_administrator_invitation === null) {
    throw new Error(`provisioning failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  for (const propertyId of properties) {
    const property = await call(
      harness,
      'PUT',
      `/v1/provisioning/organizations/${organizationId}/properties/${propertyId}`,
      {
        token: provisioning,
        body: { display_name: `Property ${propertyId.slice(-6)}` },
      },
    );
    if (property.status !== 201)
      throw new Error(`property provisioning failed: ${property.status}`);
  }
  const adminToken = await token(harness.staff, adminSubject);
  const accepted = await call(
    harness,
    'POST',
    `/v1/organizations/${organizationId}/invitations/accept`,
    {
      token: adminToken,
      body: { token: created.body.first_administrator_invitation.token },
    },
  );
  if (accepted.status !== 201 && accepted.status !== 200)
    throw new Error(`invitation failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  return { organizationId, adminToken };
}

/** Reads the security log as the monitor role (tests only). */
export async function securityEvents(
  url: string,
  sinceSequence = 0,
): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (
      await client.query<Record<string, unknown>>(
        'SELECT * FROM audit.security_event WHERE sequence > $1 ORDER BY sequence',
        [sinceSequence],
      )
    ).rows;
  } finally {
    await client.end();
  }
}

export async function lastSecuritySequence(url: string): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return Number(
      (
        await client.query<{ s: string }>(
          'SELECT coalesce(max(sequence), 0) AS s FROM audit.security_event',
        )
      ).rows[0]?.s ?? 0,
    );
  } finally {
    await client.end();
  }
}
