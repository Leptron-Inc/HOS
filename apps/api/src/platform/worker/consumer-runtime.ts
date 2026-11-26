import type pg from 'pg';
import { createRequestContext } from '../../kernel/context/context-factory.js';
import { runWithContext } from '../../kernel/context/context-store.js';
import { claimInbox } from '../../kernel/outbox/inbox.js';
import { eventContract, type EventEnvelope } from '../../kernel/outbox/event-contracts.js';
import type { Subscription } from '../../kernel/outbox/subscriptions.js';
import { backoffMs, type QueueAdapter, type QueueMessage } from '../../kernel/queue/queue.js';
import {
  errorFields,
  isUuid,
  uuidv7,
  type Logger,
  type MetricsRegistry,
  type RequestContext,
  type TenantDatabase,
  type TenantLookup,
} from '../../kernel/public.js';
import {
  definePlatformIdentity,
  PrincipalGrants,
  runWithGrants,
  type PlatformIdentity,
} from '../../modules/iam/public/index.js';

export type ConsumerOutcome = 'processed' | 'duplicate' | 'retry' | 'dead_lettered';

export interface ConsumerRuntimeOptions {
  readonly visibilityMs: number;
  readonly defaultMaxReceives: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}

/**
 * Event consumer runtime: a trusted entry point (CX-01, CX-11 to CX-13; D-018; H-JOB).
 * - The tenant comes only from the envelope (written by the outbox writer from a verified context).
 * - The organization (and property) must exist and be active, otherwise the event goes to the
 *   dead-letter path with an alert (H-JOB-03).
 * - The actor is the consumer's own platform service identity; onBehalfOf is the event's actor.
 * - The consumer's declared permissions are checked on every event (CX-12, H-JOB-05).
 * - Inbox claim and handler run in ONE tenant transaction: one business effect per event (H-JOB-06).
 * - Failures retry with exponential backoff and jitter; after maxReceives the message is dead-lettered.
 */
export class ConsumerRuntime {
  private readonly identities = new Map<string, PlatformIdentity>();

  constructor(
    private readonly queue: QueueAdapter,
    private readonly relayPool: pg.Pool,
    private readonly tenantDb: TenantDatabase,
    private readonly lookup: TenantLookup,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry,
    private readonly options: ConsumerRuntimeOptions,
    /** Permissions GRANTED to each consumer identity (separate from what the consumer declares). */
    private readonly grants: Readonly<Record<string, readonly string[]>>,
    /** Records an authorization denial in the tenant's audit (P2 AuthorizationService.recordDenial). */
    private readonly recordDenial: (ctx: RequestContext, permission: string) => Promise<void>,
  ) {}

  identityOf(subscription: Subscription): PlatformIdentity {
    let identity = this.identities.get(subscription.name);
    if (identity === undefined) {
      identity = definePlatformIdentity(
        `consumer:${subscription.name}`,
        this.grants[subscription.name] ?? [],
      );
      this.identities.set(subscription.name, identity);
    }
    return identity;
  }

  /** Receives and handles one batch for one consumer. */
  async poll(subscription: Subscription, max = 10): Promise<ConsumerOutcome[]> {
    const messages = await this.queue.receive(subscription.name, max, this.options.visibilityMs);
    const outcomes: ConsumerOutcome[] = [];
    for (const message of messages) outcomes.push(await this.handle(subscription, message));
    return outcomes;
  }

  async handle(subscription: Subscription, message: QueueMessage): Promise<ConsumerOutcome> {
    const started = process.hrtime.bigint();
    const envelope = message.body as EventEnvelope;
    const labels = { consumer: subscription.name };
    if (
      !isUuid(envelope?.organization_id) ||
      !isUuid(envelope.event_id) ||
      eventContract(envelope.type, envelope.version) === undefined
    ) {
      return this.deadLetter(subscription, message, 'envelope_invalid');
    }
    const orgStatus = await this.lookup.organizationStatus(envelope.organization_id);
    if (orgStatus !== 'active')
      return this.deadLetter(
        subscription,
        message,
        orgStatus === 'not_found' ? 'tenant_unknown' : 'tenant_inactive',
      );
    if (envelope.property_id !== null) {
      const propertyStatus = await this.lookup.propertyStatus(
        envelope.organization_id,
        envelope.property_id,
      );
      if (propertyStatus === 'not_found')
        return this.deadLetter(subscription, message, 'tenant_unknown');
    }

    const identity = this.identityOf(subscription);
    const missing = subscription.permissions.filter((p) => !identity.permissions.has(p));
    const context = createRequestContext({
      entryPoint: 'event_consumer',
      actor: { id: identity.id, realm: 'machine', kind: 'service_identity' },
      onBehalfOf: envelope.actor,
      organizationId: envelope.organization_id,
      properties:
        envelope.property_id !== null
          ? { kind: 'listed', propertyIds: [envelope.property_id] }
          : { kind: 'all_in_organization' },
      correlationId: envelope.correlation_id,
      causationId: envelope.event_id,
      requestId: uuidv7(),
    });
    if (missing.length > 0) {
      this.metrics.increment('hos_consumer_denials_total', labels);
      await this.recordDenial(context, missing[0] ?? '').catch((error: unknown) =>
        this.logger.error('consumer_denial_record_failed', errorFields(error)),
      );
      return this.deadLetter(subscription, message, 'permission_denied');
    }
    const grants = new PrincipalGrants(envelope.organization_id, identity.id, [
      { permissions: identity.permissions, propertyId: null, departmentId: null },
    ]);
    try {
      const processed = await runWithContext(context, () =>
        runWithGrants(grants, () =>
          this.tenantDb.transactionFor(context, subscription.manifest, async (tx) => {
            if (!(await claimInbox(tx, subscription.name, envelope.event_id))) return false;
            await subscription.handle(envelope, tx);
            return true;
          }),
        ),
      );
      await this.queue.delete(message);
      this.metrics.increment('hos_consumer_events_total', {
        ...labels,
        outcome: processed ? 'processed' : 'duplicate',
      });
      this.metrics.observe(
        'hos_consumer_duration_seconds',
        labels,
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      return processed ? 'processed' : 'duplicate';
    } catch (error) {
      const maxReceives = subscription.maxReceives ?? this.options.defaultMaxReceives;
      this.logger.warn('consumer_handler_failed', {
        consumer: subscription.name,
        event_type: envelope.type,
        receive_count: message.receiveCount,
        ...errorFields(error),
      });
      if (message.receiveCount >= maxReceives)
        return this.deadLetter(subscription, message, 'max_receives_exceeded');
      await this.queue.release(
        message,
        backoffMs(message.receiveCount, this.options.backoffBaseMs, this.options.backoffCapMs),
        'handler_failed',
      );
      this.metrics.increment('hos_consumer_events_total', { ...labels, outcome: 'retry' });
      return 'retry';
    }
  }

  /** Moves a message to the tenant's dead-letter store and raises an alert (P6). */
  private async deadLetter(
    subscription: Subscription,
    message: QueueMessage,
    reason: string,
  ): Promise<ConsumerOutcome> {
    const envelope = message.body as Partial<EventEnvelope>;
    const client = await this.relayPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO eventing.dead_letter (id, organization_id, queue, event_id, event_type, envelope, reason, receive_count, failed_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'dead')`,
        [
          uuidv7(),
          isUuid(envelope.organization_id)
            ? envelope.organization_id
            : '00000000-0000-0000-0000-000000000000',
          subscription.name,
          isUuid(envelope.event_id) ? envelope.event_id : '00000000-0000-0000-0000-000000000000',
          typeof envelope.type === 'string' ? envelope.type.slice(0, 200) : 'unknown',
          JSON.stringify(message.body),
          reason,
          message.receiveCount,
        ],
      );
      await client.query('DELETE FROM eventing.queue_message WHERE id = $1 AND receipt = $2', [
        message.id,
        message.receipt,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('dead_letter_write_failed', {
        consumer: subscription.name,
        ...errorFields(error),
      });
      throw error;
    } finally {
      client.release();
    }
    this.metrics.increment('hos_dead_letters_total', { consumer: subscription.name, reason });
    this.logger.error('event_dead_lettered', {
      consumer: subscription.name,
      reason,
      event_type: envelope.type ?? 'unknown',
    });
    return 'dead_lettered';
  }
}
