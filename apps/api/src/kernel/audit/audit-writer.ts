import type pg from 'pg';
import { canonicalJson, GENESIS_HASH, sha256 } from '../canonical-json.js';
import type { ColumnClass, ModuleManifest } from '../database/manifest.js';
import { kernelConnection, type TenantTx } from '../database/tenant-transaction.js';
import { uuidv7 } from '../ids.js';

/**
 * P7 audit writer (kernel layer L1; module map G5, §1.1, §7.1; tenancy specification E-24, E-25).
 * Writes one append-only, hash-chained audit record in the SAME transaction as the change, taking
 * the verified actor, tenant and correlation from the trusted context, without calling P2.
 *
 * Redaction is applied by column classification from the owning module's manifest; modules cannot
 * bypass it: `public` and `internal` values are recorded; `personal` and `sensitive` values become
 * a redaction marker that points at the entity's version history (the owning module keeps access
 * control on it); `secret` fields are refused; unclassified fields are refused (fail closed).
 */
export interface AuditChange {
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface AuditEntry {
  /** The owning table, as in the module manifest (for example `app.tenant_department`). */
  readonly table: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  /** The entity version this record describes (E-24); null for entities without versions. */
  readonly entityVersion: number | null;
  readonly propertyId?: string | null;
  readonly changes: Readonly<Record<string, AuditChange>>;
}

export class AuditRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditRedactionError';
  }
}

export interface RedactionMarker {
  readonly redacted: true;
  readonly class: 'personal' | 'sensitive';
  readonly ref: { readonly entity_id: string; readonly version: number | null };
}

export function redactChanges(
  manifest: ModuleManifest,
  entry: AuditEntry,
): Record<string, { before?: unknown; after?: unknown }> {
  const columns =
    manifest.tables.find((candidate) => candidate.table === entry.table)?.columns ??
    manifest.auditRecords?.[entry.table];
  if (columns === undefined)
    throw new AuditRedactionError(`${entry.table} is not in the ${manifest.module} manifest`);
  const payload: Record<string, { before?: unknown; after?: unknown }> = {};
  for (const [field, change] of Object.entries(entry.changes)) {
    const classification: ColumnClass | undefined = columns[field];
    if (classification === undefined)
      throw new AuditRedactionError(`${entry.table}.${field} is not classified (E-26)`);
    if (classification === 'secret')
      throw new AuditRedactionError(`${entry.table}.${field} is secret and is never audited`);
    const value = (v: unknown): unknown =>
      classification === 'personal' || classification === 'sensitive'
        ? ({
            redacted: true,
            class: classification,
            ref: { entity_id: entry.entityId, version: entry.entityVersion },
          } satisfies RedactionMarker)
        : v;
    payload[field] = {
      ...('before' in change ? { before: value(change.before) } : {}),
      ...('after' in change ? { after: value(change.after) } : {}),
    };
  }
  return payload;
}

/** The fields covered by the hash, in a fixed shape (the hash covers the redacted payload). */
export interface AuditHashInput {
  readonly id: string;
  readonly organization_id: string;
  readonly property_id: string | null;
  readonly sequence: number;
  readonly recorded_at: string;
  readonly module: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly entity_version: number | null;
  readonly actor_id: string;
  readonly actor_realm: string;
  readonly actor_kind: string;
  readonly on_behalf_of_id: string | null;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly request_id: string;
  readonly entry_point: string;
  readonly changed_fields: readonly string[];
  readonly payload: unknown;
}

export function auditRecordHash(previous: Buffer, input: AuditHashInput): Buffer {
  return sha256(previous, canonicalJson(input));
}

export async function appendAudit<DB>(
  tx: TenantTx<DB>,
  manifest: ModuleManifest,
  entry: AuditEntry,
): Promise<string> {
  if (tx.module !== manifest.module)
    throw new AuditRedactionError('a module audits only its own tables (G2)');
  const client = kernelConnection(tx);
  const ctx = tx.context;
  const payload = redactChanges(manifest, entry);
  const organizationId = ctx.tenant.organizationId;

  await client.query(
    `INSERT INTO audit.audit_chain_head (organization_id, id, last_sequence, last_hash, updated_at)
     VALUES ($1, $2, 0, $3, now()) ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId, uuidv7(), GENESIS_HASH],
  );
  const head = await client.query<{ last_sequence: number; last_hash: Buffer }>(
    'SELECT last_sequence, last_hash FROM audit.audit_chain_head WHERE organization_id = $1 FOR UPDATE',
    [organizationId],
  );
  const previous = head.rows[0];
  if (previous === undefined)
    throw new AuditRedactionError('audit chain head is not visible in this context');

  const input: AuditHashInput = {
    id: uuidv7(),
    organization_id: organizationId,
    property_id: entry.propertyId ?? null,
    sequence: Number(previous.last_sequence) + 1,
    recorded_at: new Date().toISOString(),
    module: manifest.module,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    entity_version: entry.entityVersion,
    actor_id: ctx.actor.id,
    actor_realm: ctx.actor.realm,
    actor_kind: ctx.actor.kind,
    on_behalf_of_id: ctx.onBehalfOf?.id ?? null,
    correlation_id: ctx.correlationId,
    causation_id: ctx.causationId,
    request_id: ctx.requestId,
    entry_point: ctx.entryPoint,
    changed_fields: Object.keys(payload).sort(),
    payload,
  };
  const hash = auditRecordHash(previous.last_hash, input);
  await client.query(
    `INSERT INTO audit.audit_record
       (id, organization_id, property_id, sequence, recorded_at, module, action, entity_type, entity_id, entity_version,
        actor_id, actor_realm, actor_kind, on_behalf_of_id, correlation_id, causation_id, request_id, entry_point,
        changed_fields, payload, previous_hash, record_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
    [
      input.id,
      input.organization_id,
      input.property_id,
      input.sequence,
      input.recorded_at,
      input.module,
      input.action,
      input.entity_type,
      input.entity_id,
      input.entity_version,
      input.actor_id,
      input.actor_realm,
      input.actor_kind,
      input.on_behalf_of_id,
      input.correlation_id,
      input.causation_id,
      input.request_id,
      input.entry_point,
      input.changed_fields,
      JSON.stringify(input.payload),
      previous.last_hash,
      hash,
    ],
  );
  await client.query(
    'UPDATE audit.audit_chain_head SET last_sequence = $2, last_hash = $3, updated_at = now() WHERE organization_id = $1',
    [organizationId, input.sequence, hash],
  );
  return input.id;
}

export interface ChainVerification {
  readonly organizationId: string;
  readonly records: number;
  readonly valid: boolean;
  readonly firstInvalidSequence: number | null;
}

interface AuditRow extends Omit<AuditHashInput, 'recorded_at' | 'payload'> {
  readonly recorded_at: Date;
  readonly payload: unknown;
  readonly previous_hash: Buffer;
  readonly record_hash: Buffer;
}

/** Verifies one organization's chain (map §7.2 integrity check; E-46(5)). Run by the monitor role. */
export async function verifyAuditChain(
  client: pg.ClientBase,
  organizationId: string,
  batchSize = 1000,
): Promise<ChainVerification> {
  let previous: Buffer = GENESIS_HASH;
  let expected = 1;
  let records = 0;
  for (;;) {
    const rows = await client.query<AuditRow>(
      `SELECT id, organization_id, property_id, sequence, recorded_at, module, action, entity_type, entity_id, entity_version,
              actor_id, actor_realm, actor_kind, on_behalf_of_id, correlation_id, causation_id, request_id, entry_point,
              changed_fields, payload, previous_hash, record_hash
         FROM audit.audit_record WHERE organization_id = $1 AND sequence >= $2 ORDER BY sequence LIMIT $3`,
      [organizationId, expected, batchSize],
    );
    if (rows.rows.length === 0) break;
    for (const row of rows.rows) {
      const {
        previous_hash: previousHash,
        record_hash: recordHash,
        recorded_at: recordedAt,
        ...rest
      } = row;
      // Normalize numeric columns: a client without the kernel's int8 parser returns them as strings.
      const input: AuditHashInput = {
        ...rest,
        sequence: Number(rest.sequence),
        entity_version: rest.entity_version === null ? null : Number(rest.entity_version),
        recorded_at: recordedAt.toISOString(),
      };
      const ok =
        Number(row.sequence) === expected &&
        previousHash.equals(previous) &&
        auditRecordHash(previous, input).equals(recordHash);
      if (!ok) return { organizationId, records, valid: false, firstInvalidSequence: expected };
      previous = recordHash;
      expected += 1;
      records += 1;
    }
  }
  const head = await client.query<{ last_sequence: number; last_hash: Buffer }>(
    'SELECT last_sequence, last_hash FROM audit.audit_chain_head WHERE organization_id = $1',
    [organizationId],
  );
  const headRow = head.rows[0];
  // A deleted tail is detected by the head pointing past the last surviving record.
  const headOk =
    headRow === undefined
      ? records === 0
      : Number(headRow.last_sequence) === records && headRow.last_hash.equals(previous);
  return {
    organizationId,
    records,
    valid: headOk,
    firstInvalidSequence: headOk ? null : records + 1,
  };
}
