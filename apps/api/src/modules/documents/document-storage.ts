import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Document storage abstraction (P5 protection model, module map §5.1 P5).
 * - Production: S3 with KMS keys per cell, a separate key for sensitive classes, encryption context
 *   holding tenant and property IDs, private buckets, TLS only. NOT IMPLEMENTED in Phase 1: it needs
 *   approved AWS resources (D-025). This interface is its contract; presigned URLs (5 minutes,
 *   non-sensitive classes only) belong to that adapter.
 * - Local (development and tests): AES-256-GCM per object; the organization, property and object
 *   key are authenticated data, so an object can't be decrypted under another tenant's context.
 * Object keys are opaque (256 random bits) and never leave the server.
 */
export interface StorageContext {
  readonly organizationId: string;
  readonly propertyId: string | null;
}

export interface DocumentStorage {
  readonly name: string;
  put(context: StorageContext, content: Buffer): Promise<string>;
  get(context: StorageContext, key: string): Promise<Buffer>;
  delete(context: StorageContext, key: string): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super('no document storage is configured');
    this.name = 'StorageUnavailableError';
  }
}

export class UnavailableDocumentStorage implements DocumentStorage {
  readonly name = 'unavailable';
  put(): Promise<string> {
    return Promise.reject(new StorageUnavailableError());
  }
  get(): Promise<Buffer> {
    return Promise.reject(new StorageUnavailableError());
  }
  delete(): Promise<void> {
    return Promise.reject(new StorageUnavailableError());
  }
}

const KEY = /^[A-Za-z0-9_-]{43}$/;

export class LocalEncryptedDocumentStorage implements DocumentStorage {
  readonly name = 'local-encrypted';
  private readonly key: Buffer;

  constructor(
    private readonly directory: string,
    keyBase64: string,
  ) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32)
      throw new Error('HOS_DOCUMENT_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    this.key = key;
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('invalid object key');
    return join(this.directory, key);
  }

  private aad(context: StorageContext, key: string): Buffer {
    return Buffer.from(`${context.organizationId}\n${context.propertyId ?? '-'}\n${key}`, 'utf8');
  }

  async put(context: StorageContext, content: Buffer): Promise<string> {
    const key = randomBytes(32).toString('base64url');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(context, key));
    const body = Buffer.concat([cipher.update(content), cipher.final()]);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), Buffer.concat([iv, cipher.getAuthTag(), body]), {
      flag: 'wx',
      mode: 0o600,
    });
    return key;
  }

  async get(context: StorageContext, key: string): Promise<Buffer> {
    const blob = await readFile(this.path(key));
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12));
    decipher.setAAD(this.aad(context, key));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
  }

  async delete(_context: StorageContext, key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
