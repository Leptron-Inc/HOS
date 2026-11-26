import { kernelConnection, type TenantTx } from '../database/tenant-transaction.js';
import { uuidv7 } from '../ids.js';
import { EventContractError, type EventContract } from './event-contracts.js';

/**
 * P3 outbox writer (kernel layer L1; D-018; module map G4, §7.1). Writes the event in the SAME
 * transaction as the state change, so an event exists exactly when the change committed. The
 * envelope's tenant, actor and correlation come only from the trusted context (CX-11): callers
 * cannot set them. Delivery is at least once; consumers deduplicate through the inbox.
 */
export interface PublishOptions {
  /** Property the event concerns (an attribute; isolation is by organization). */
  readonly propertyId?: string | null;
  /** Ordering key for FIFO delivery (by property or by record, never one global group). */
  readonly orderingKey?: string;
  /** Deterministic event ID (E-03) where the caller needs one; otherwise UUIDv7. */
  readonly eventId?: string;
}

export async function publishEvent<DB, TPayload>(
  tx: TenantTx<DB>,
  contract: EventContract<TPayload>,
  payload: TPayload,
  options: PublishOptions = {},
): Promise<string> {
  const parsed = contract.schema.safeParse(payload);
  if (!parsed.success) {
    throw new EventContractError(`payload does not match ${contract.type}@${contract.version}`);
  }
  const ctx = tx.context;
  if (options.propertyId !== undefined && options.propertyId !== null) {
    const scope = ctx.tenant.properties;
    if (scope.kind === 'listed' && !scope.propertyIds.includes(options.propertyId as never)) {
      throw new EventContractError('an event cannot name a property outside the context scope');
    }
  }
  const eventId = options.eventId ?? uuidv7();
  const orderingKey = options.orderingKey ?? options.propertyId ?? ctx.tenant.organizationId;
  await kernelConnection(tx).query(
    `INSERT INTO eventing.outbox (id, organization_id, property_id, event_type, event_version, payload, occurred_at,
       correlation_id, causation_id, actor_id, actor_realm, actor_kind, on_behalf_of_id, ordering_key)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13)`,
    [
      eventId,
      ctx.tenant.organizationId,
      options.propertyId ?? null,
      contract.type,
      contract.version,
      JSON.stringify(parsed.data),
      ctx.correlationId,
      ctx.causationId,
      ctx.actor.id,
      ctx.actor.realm,
      ctx.actor.kind,
      ctx.onBehalfOf?.id ?? null,
      orderingKey,
    ],
  );
  return eventId;
}
