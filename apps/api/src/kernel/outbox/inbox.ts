import { kernelConnection, type TenantTx } from '../database/tenant-transaction.js';
import { uuidv7 } from '../ids.js';

/**
 * Consumer inbox (P3 kernel; D-018; H-JOB-06). Claimed first in the consumer's business
 * transaction: if this (consumer, event) was already processed, the claim returns false and the
 * handler is skipped; otherwise the claim commits or rolls back together with the handler's
 * changes. Delivery is at least once; the business effect happens exactly once.
 */
export async function claimInbox<DB>(
  tx: TenantTx<DB>,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const result = await kernelConnection(tx).query(
    `INSERT INTO eventing.inbox (organization_id, consumer, event_id, id, processed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (organization_id, consumer, event_id) DO NOTHING`,
    [tx.context.tenant.organizationId, consumer, eventId, uuidv7()],
  );
  return result.rowCount === 1;
}
