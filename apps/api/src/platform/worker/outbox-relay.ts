import type pg from 'pg';
import { errorFields, type Logger, type MetricsRegistry } from '../../kernel/public.js';
import type { EventEnvelope } from '../../kernel/outbox/event-contracts.js';
import { subscribersOf } from '../../kernel/outbox/subscriptions.js';
import type { QueueAdapter } from '../../kernel/queue/queue.js';

interface OutboxRow {
  id: string;
  organization_id: string;
  property_id: string | null;
  event_type: string;
  event_version: number;
  payload: unknown;
  occurred_at: Date;
  correlation_id: string;
  causation_id: string | null;
  actor_id: string;
  actor_realm: EventEnvelope['actor']['realm'];
  actor_kind: EventEnvelope['actor']['kind'];
  on_behalf_of_id: string | null;
  ordering_key: string;
}

export function envelopeOf(row: OutboxRow): EventEnvelope {
  return {
    event_id: row.id,
    type: row.event_type,
    version: row.event_version,
    organization_id: row.organization_id,
    property_id: row.property_id,
    occurred_at: row.occurred_at.toISOString(),
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    actor: { id: row.actor_id, realm: row.actor_realm, kind: row.actor_kind },
    on_behalf_of_id: row.on_behalf_of_id,
    ordering_key: row.ordering_key,
    payload: row.payload,
  };
}

/**
 * Outbox relay (P3; D-018). Runs as hos_relay, which has cross-tenant access only on the eventing
 * tables. Each batch moves unpublished events to the queues of their subscribers and marks them
 * published in ONE transaction (with the local queue adapter both live in PostgreSQL; with SQS the
 * send happens before the mark, so a crash re-sends: at least once, never lost). It also re-enqueues
 * dead letters whose replay was requested (audited by the tenant API).
 */
export class OutboxRelay {
  constructor(
    private readonly relayPool: pg.Pool,
    private readonly queue: QueueAdapter,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry,
    private readonly batchSize = 100,
  ) {}

  /** Publishes one batch; returns the number of events relayed. */
  async relayBatch(): Promise<number> {
    const client = await this.relayPool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query<OutboxRow>(
        `SELECT id, organization_id, property_id, event_type, event_version, payload, occurred_at, correlation_id, causation_id,
                actor_id, actor_realm, actor_kind, on_behalf_of_id, ordering_key
           FROM eventing.outbox WHERE published_at IS NULL
          ORDER BY occurred_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      for (const row of rows.rows) {
        const envelope = envelopeOf(row);
        for (const subscriber of subscribersOf(row.event_type, row.event_version)) {
          await this.queue.send(client, subscriber.name, row.ordering_key, envelope);
        }
      }
      if (rows.rows.length > 0) {
        await client.query(
          'UPDATE eventing.outbox SET published_at = now(), publish_attempts = publish_attempts + 1 WHERE id = ANY ($1::uuid[])',
          [rows.rows.map((r) => r.id)],
        );
      }
      await client.query('COMMIT');
      if (rows.rows.length > 0)
        this.metrics.increment('hos_outbox_relayed_total', {}, rows.rows.length);
      return rows.rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.metrics.increment('hos_outbox_relay_failures_total', {});
      this.logger.error('outbox_relay_failed', errorFields(error));
      return 0;
    } finally {
      client.release();
    }
  }

  /** Re-enqueues dead letters whose replay was requested through the tenant API. */
  async replayBatch(): Promise<number> {
    const client = await this.relayPool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query<{ id: string; queue: string; envelope: EventEnvelope }>(
        `SELECT id, queue, envelope FROM eventing.dead_letter WHERE status = 'replay_requested'
          ORDER BY replay_requested_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows.rows) {
        await this.queue.send(client, row.queue, row.envelope.ordering_key, row.envelope);
        await client.query(
          "UPDATE eventing.dead_letter SET status = 'replayed', replayed_at = now(), version = version + 1 WHERE id = $1",
          [row.id],
        );
      }
      await client.query('COMMIT');
      if (rows.rows.length > 0)
        this.metrics.increment('hos_dead_letters_replayed_total', {}, rows.rows.length);
      return rows.rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('dead_letter_replay_failed', errorFields(error));
      return 0;
    } finally {
      client.release();
    }
  }

  /** Unpublished outbox depth and age (P6 background monitoring). */
  async lag(): Promise<{ pending: number; oldestSeconds: number }> {
    const result = await this.relayPool.query<{ pending: number; oldest: number | null }>(
      `SELECT count(*)::int AS pending, extract(epoch FROM now() - min(occurred_at))::float8 AS oldest
         FROM eventing.outbox WHERE published_at IS NULL`,
    );
    return { pending: result.rows[0]?.pending ?? 0, oldestSeconds: result.rows[0]?.oldest ?? 0 };
  }
}
