import { canonicalJson, sha256 } from '../canonical-json.js';
import type { ModuleManifest } from '../database/manifest.js';
import { isLockTimeout } from '../database/errors.js';
import { kernelConnection, type TenantTx } from '../database/tenant-transaction.js';
import { IdempotencyInProgressError, IdempotencyKeyReuseError } from '../errors.js';

/**
 * Idempotency keys (tenancy specification F-06 to F-09, F-19 to F-24; kernel writer, B-07
 * exception). Each module has its own `<prefix>_idempotency_key` table, written in the same
 * transaction as the business change. The statements are the validated idem_acquire, idem_lookup
 * and idem_complete, with the module's table name substituted.
 */
export interface FingerprintInput {
  readonly method: string;
  readonly routeTemplate: string;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly body: unknown;
  readonly ifMatch: string | null;
}

/** F-19: SHA-256 over the RFC 8785 form; key order and whitespace don't matter. */
export function requestFingerprint(input: FingerprintInput): Buffer {
  const query = Object.fromEntries(
    Object.entries(input.query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return sha256(
    canonicalJson({
      method: input.method,
      route_template: input.routeTemplate,
      path_params: input.pathParams,
      query,
      body: input.body ?? null,
      if_match: input.ifMatch,
    }),
  );
}

export interface StoredResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type AcquireResult =
  | { readonly kind: 'owner' }
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  | { readonly kind: 'reuse' }
  | { readonly kind: 'in_progress' };

const REPLAYED_HEADERS = new Set(['location', 'etag', 'content-type']);

function idempotencyTable(manifest: ModuleManifest): string {
  const table = `app.${manifest.prefix}idempotency_key`;
  if (!manifest.tables.some((t) => t.table === table))
    throw new Error(`${manifest.module} has no idempotency store`);
  // The name comes from the module manifest (code), never from input; quoted as an identifier.
  return `app."${manifest.prefix}idempotency_key"`;
}

/** The idempotency facts of one POST request, built by the entry point from the request (F-07, F-19). */
export interface IdempotentRequest {
  /** HTTP method plus route template (F-07). */
  readonly operation: string;
  readonly key: string;
  readonly fingerprint: Buffer;
}

export interface WriteResult extends StoredResponse {
  readonly replayed?: boolean;
  /**
   * The body to store for replay when the live body contains a one-time secret (for example an
   * invitation token): secrets are never stored in tenant tables (E-26).
   */
  readonly storedBody?: unknown;
}

export class IdempotencyStore {
  /**
   * Runs `work` exactly once per (organization, actor, operation, key): a committed result with the
   * same fingerprint is replayed; a different fingerprint is a reuse (422); a concurrent holder makes
   * this request wait up to lock_timeout, then 409 in progress (F-09, F-21, F-22).
   */
  async run<DB>(
    tx: TenantTx<DB>,
    manifest: ModuleManifest,
    request: IdempotentRequest,
    work: () => Promise<WriteResult>,
  ): Promise<WriteResult> {
    let acquired: AcquireResult;
    try {
      acquired = await this.acquire(
        tx,
        manifest,
        request.operation,
        request.key,
        request.fingerprint,
      );
    } catch (error) {
      if (isLockTimeout(error)) throw new IdempotencyInProgressError();
      throw error;
    }
    switch (acquired.kind) {
      case 'replay':
        return { ...acquired.response, replayed: true };
      case 'reuse':
        throw new IdempotencyKeyReuseError();
      case 'in_progress':
        throw new IdempotencyInProgressError();
      case 'owner': {
        const result = await work();
        if (result.status < 500)
          await this.complete(tx, manifest, request.operation, request.key, {
            status: result.status,
            headers: result.headers,
            body: result.storedBody !== undefined ? result.storedBody : result.body,
          });
        return result;
      }
    }
  }

  constructor(private readonly expiry: string = '24 hours') {}

  /** F-20, F-21: run first in the business transaction. A committed same-fingerprint row replays. */
  async acquire<DB>(
    tx: TenantTx<DB>,
    manifest: ModuleManifest,
    operation: string,
    key: string,
    fingerprint: Buffer,
  ): Promise<AcquireResult> {
    if (key.length < 1 || key.length > 255)
      throw new RangeError('Idempotency-Key must be 1-255 characters (F-07)');
    const table = idempotencyTable(manifest);
    const client = kernelConnection(tx);
    const ctx = tx.context;
    const acquired = await client.query(
      `INSERT INTO ${table} AS k
             (organization_id, actor_id, operation, idempotency_key, request_fingerprint, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, now(), now() + $6::interval)
       ON CONFLICT (organization_id, actor_id, operation, idempotency_key) DO UPDATE
          SET request_fingerprint = EXCLUDED.request_fingerprint,
              response_status = NULL, response_headers = NULL, response_body = NULL,
              created_at = EXCLUDED.created_at, completed_at = NULL, expires_at = EXCLUDED.expires_at
        WHERE k.expires_at <= now()
       RETURNING k.idempotency_key`,
      [ctx.tenant.organizationId, ctx.actor.id, operation, key, fingerprint, this.expiry],
    );
    if (acquired.rowCount === 1) return { kind: 'owner' };
    const existing = await client.query<{
      request_fingerprint: Buffer;
      response_status: number | null;
      response_headers: Record<string, string> | null;
      response_body: unknown;
    }>(
      `SELECT request_fingerprint, response_status, response_headers, response_body
         FROM ${table}
        WHERE organization_id = $1 AND actor_id = $2 AND operation = $3 AND idempotency_key = $4 AND expires_at > now()`,
      [ctx.tenant.organizationId, ctx.actor.id, operation, key],
    );
    const row = existing.rows[0];
    if (row === undefined) return { kind: 'in_progress' };
    if (!row.request_fingerprint.equals(fingerprint)) return { kind: 'reuse' };
    if (row.response_status === null) return { kind: 'in_progress' };
    return {
      kind: 'replay',
      response: {
        status: row.response_status,
        headers: row.response_headers ?? {},
        body: row.response_body,
      },
    };
  }

  /** F-22: stores the response of a committed request (only 2xx/4xx business results reach here). */
  async complete<DB>(
    tx: TenantTx<DB>,
    manifest: ModuleManifest,
    operation: string,
    key: string,
    response: StoredResponse,
  ): Promise<void> {
    const headers = Object.fromEntries(
      Object.entries(response.headers).filter(([name]) => REPLAYED_HEADERS.has(name.toLowerCase())),
    );
    await kernelConnection(tx).query(
      `UPDATE ${idempotencyTable(manifest)}
          SET response_status = $5, response_headers = $6, response_body = $7, completed_at = now()
        WHERE organization_id = $1 AND actor_id = $2 AND operation = $3 AND idempotency_key = $4`,
      [
        tx.context.tenant.organizationId,
        tx.context.actor.id,
        operation,
        key,
        response.status,
        JSON.stringify(headers),
        JSON.stringify(response.body ?? null),
      ],
    );
  }
}
