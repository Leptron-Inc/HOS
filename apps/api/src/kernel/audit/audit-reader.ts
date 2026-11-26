import { kernelConnection, type TenantTx } from '../database/tenant-transaction.js';
import type { ModuleManifest } from '../database/manifest.js';
import { verifyAuditChain, type ChainVerification } from './audit-writer.js';

/**
 * Tenant reads of the audit store (P7 `/v1/audit`; map §1.1). Runs in the caller's tenant
 * transaction, so row-level security limits it to the tenant. Payloads are already redacted at
 * write time (sensitive values are markers pointing at the owning module's history).
 */
export interface AuditRecordView {
  readonly id: string;
  readonly sequence: number;
  readonly recorded_at: string;
  readonly module: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly entity_version: number | null;
  readonly property_id: string | null;
  readonly actor_id: string;
  readonly actor_realm: string;
  readonly on_behalf_of_id: string | null;
  readonly correlation_id: string;
  readonly changed_fields: readonly string[];
  readonly payload: unknown;
}

export async function listAuditRecords<DB>(
  tx: TenantTx<DB>,
  filters: {
    entityType: string | null;
    entityId: string | null;
    afterSequence: number | null;
    limit: number;
  },
): Promise<AuditRecordView[]> {
  const result = await kernelConnection(tx).query<
    Omit<AuditRecordView, 'recorded_at'> & { recorded_at: Date }
  >(
    `SELECT id, sequence, recorded_at, module, action, entity_type, entity_id, entity_version, property_id, actor_id, actor_realm,
            on_behalf_of_id, correlation_id, changed_fields, payload
       FROM audit.audit_record
      WHERE organization_id = $1 AND ($2::text IS NULL OR entity_type = $2) AND ($3::uuid IS NULL OR entity_id = $3)
        AND ($4::bigint IS NULL OR sequence > $4)
      ORDER BY sequence LIMIT $5`,
    [
      tx.context.tenant.organizationId,
      filters.entityType,
      filters.entityId,
      filters.afterSequence,
      filters.limit,
    ],
  );
  return result.rows.map((row) => ({
    ...row,
    sequence: Number(row.sequence),
    entity_version: row.entity_version === null ? null : Number(row.entity_version),
    recorded_at: row.recorded_at.toISOString(),
  }));
}

/** Compliance evidence for the tenant: verification of its own audit chain. */
export function verifyTenantAuditChain<DB>(tx: TenantTx<DB>): Promise<ChainVerification> {
  return verifyAuditChain(kernelConnection(tx), tx.context.tenant.organizationId);
}

/**
 * Erasure of a module's version history (E-36): calls `kernel.<table>_erase_history`, the
 * allowlisted definer function owned by hos_history_eraser and executable only by hos_worker.
 * A module may erase only its own tables' history.
 */
export async function eraseHistory<DB>(
  tx: TenantTx<DB>,
  manifest: ModuleManifest,
  table: string,
  entityId: string,
  reason: 'retention_expired' | 'data_subject_request' | 'legal_order',
  reference: string,
): Promise<number> {
  const entry = manifest.tables.find((t) => t.table === table && t.history !== undefined);
  if (entry === undefined || tx.module !== manifest.module)
    throw new Error(`${manifest.module} has no history for ${table}`);
  const name = table.replace(/^app\./, '');
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('invalid table name');
  const result = await kernelConnection(tx).query<{ n: number }>(
    `SELECT kernel."${name}_erase_history"($1, $2, $3) AS n`,
    [entityId, reason, reference],
  );
  return Number(result.rows[0]?.n ?? 0);
}
