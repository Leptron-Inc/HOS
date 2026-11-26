import { kernelConnection, type TenantTx } from '../database/tenant-transaction.js';
import { NotFoundError, StateConflictError, VersionConflictError } from '../errors.js';

/**
 * Tenant access to the P3 dead-letter store (kernel-owned table, B-07 exception). Reads and replay
 * requests run in the caller's tenant transaction, so row-level security limits them to the tenant;
 * the relay performs the replay (outbox-relay.ts).
 */
export interface DeadLetterView {
  readonly id: string;
  readonly queue: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly reason: string;
  readonly receive_count: number;
  readonly failed_at: string;
  readonly status: 'dead' | 'replay_requested' | 'replayed';
  readonly version: number;
}

interface Row extends Omit<DeadLetterView, 'failed_at'> {
  readonly failed_at: Date;
}

const view = (row: Row): DeadLetterView => ({
  ...row,
  version: Number(row.version),
  failed_at: row.failed_at.toISOString(),
});

export async function listDeadLetters<DB>(
  tx: TenantTx<DB>,
  status: DeadLetterView['status'] | null,
  limit: number,
  afterId: string | null,
): Promise<DeadLetterView[]> {
  const result = await kernelConnection(tx).query<Row>(
    `SELECT id, queue, event_id, event_type, reason, receive_count, failed_at, status, version
       FROM eventing.dead_letter
      WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id > $3)
      ORDER BY id LIMIT $4`,
    [tx.context.tenant.organizationId, status, afterId, limit],
  );
  return result.rows.map(view);
}

/** Marks a dead letter for replay (the caller audits the request). */
export async function requestDeadLetterReplay<DB>(
  tx: TenantTx<DB>,
  id: string,
  expectedVersion: number,
): Promise<DeadLetterView> {
  const client = kernelConnection(tx);
  const current = await client.query<Row>(
    `SELECT id, queue, event_id, event_type, reason, receive_count, failed_at, status, version
       FROM eventing.dead_letter WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [tx.context.tenant.organizationId, id],
  );
  const row = current.rows[0];
  if (row === undefined) throw new NotFoundError();
  if (Number(row.version) !== expectedVersion) throw new VersionConflictError(Number(row.version));
  if (row.status !== 'dead') throw new StateConflictError('workflow.dead_letter_not_replayable');
  const updated = await client.query<Row>(
    `UPDATE eventing.dead_letter
        SET status = 'replay_requested', replay_requested_by = $3, replay_requested_at = now(), version = version + 1
      WHERE organization_id = $1 AND id = $2
      RETURNING id, queue, event_id, event_type, reason, receive_count, failed_at, status, version`,
    [tx.context.tenant.organizationId, id, tx.context.actor.id],
  );
  const result = updated.rows[0];
  if (result === undefined) throw new NotFoundError();
  return view(result);
}
