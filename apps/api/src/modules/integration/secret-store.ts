import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Credential storage abstraction (P4; tenancy specification E-26: secrets never in tenant tables;
 * technical architecture §10: AWS Secrets Manager in production). Tenant tables hold only the
 * reference. Secrets are never logged, audited or returned by any API.
 *
 * Adapters:
 * - LocalEncryptedSecretStore: local development and automated tests. AES-256-GCM per secret, key
 *   from HOS_LOCAL_SECRETS_KEY (32 bytes, base64), files readable by the process owner only.
 * - AWS Secrets Manager: production. NOT IMPLEMENTED in Phase 1: it needs approved AWS resources
 *   (D-025). The interface below is its contract (references `aws-sm:<arn suffix>`).
 */
export interface SecretStore {
  /** Stores a secret value scoped to one organization; returns its reference. */
  put(organizationId: string, value: Readonly<Record<string, string>>): Promise<string>;
  get(organizationId: string, reference: string): Promise<Readonly<Record<string, string>>>;
  /** Replaces the value behind a reference (rotation). */
  replace(
    organizationId: string,
    reference: string,
    value: Readonly<Record<string, string>>,
  ): Promise<void>;
  delete(organizationId: string, reference: string): Promise<void>;
}

export class SecretStoreUnavailableError extends Error {
  constructor() {
    super('no secret store is configured');
    this.name = 'SecretStoreUnavailableError';
  }
}

/** Fail-closed store used when none is configured: integrations needing credentials can't be set up. */
export class UnavailableSecretStore implements SecretStore {
  put(): Promise<string> {
    return Promise.reject(new SecretStoreUnavailableError());
  }
  get(): Promise<Readonly<Record<string, string>>> {
    return Promise.reject(new SecretStoreUnavailableError());
  }
  replace(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError());
  }
  delete(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError());
  }
}

const REF = /^local:([0-9a-f-]{36})$/;

export class LocalEncryptedSecretStore implements SecretStore {
  private readonly key: Buffer;

  constructor(
    private readonly directory: string,
    keyBase64: string,
  ) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32)
      throw new Error('HOS_LOCAL_SECRETS_KEY must be 32 bytes, base64-encoded');
    this.key = key;
  }

  private path(reference: string): string {
    const match = REF.exec(reference);
    if (!match) throw new Error('not a local secret reference');
    return join(this.directory, `${match[1]}.secret`);
  }

  async put(organizationId: string, value: Readonly<Record<string, string>>): Promise<string> {
    const reference = `local:${randomUUID()}`;
    await this.write(organizationId, reference, value, 'wx');
    return reference;
  }

  async replace(
    organizationId: string,
    reference: string,
    value: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.get(organizationId, reference); // the reference must exist and belong to the organization
    await this.write(organizationId, reference, value, 'w');
  }

  async get(organizationId: string, reference: string): Promise<Readonly<Record<string, string>>> {
    const blob = await readFile(this.path(reference));
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    // The organization is authenticated data: a reference can't be read under another tenant.
    decipher.setAAD(Buffer.from(`${organizationId}\n${reference}`, 'utf8'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Record<string, string>;
  }

  async delete(organizationId: string, reference: string): Promise<void> {
    await this.get(organizationId, reference);
    await rm(this.path(reference), { force: true });
  }

  private async write(
    organizationId: string,
    reference: string,
    value: Readonly<Record<string, string>>,
    flag: 'wx' | 'w',
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${organizationId}\n${reference}`, 'utf8'));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    await writeFile(this.path(reference), Buffer.concat([iv, cipher.getAuthTag(), body]), {
      flag,
      mode: 0o600,
    });
  }
}
