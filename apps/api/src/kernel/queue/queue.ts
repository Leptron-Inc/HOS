import type pg from 'pg';
import { uuidv7 } from '../ids.js';

/**
 * Queue adapter (P3; D-018). Production uses AWS SQS FIFO (needs approved AWS resources, D-025);
 * this file defines the contract and the LOCAL adapter, a durable PostgreSQL table used for local
 * development and automated tests. Semantics follow SQS FIFO: at-least-once delivery; strict order
 * per message group (only the oldest message of a group is receivable, so a failing head blocks its
 * group until it succeeds or is dead-lettered); a visibility timeout; a receive count that drives
 * the redrive to the dead-letter path.
 */
export interface QueueMessage {
  readonly id: string;
  readonly queue: string;
  readonly group: string;
  readonly body: unknown;
  readonly receiveCount: number;
  readonly receipt: string;
  readonly enqueuedAt: Date;
}

export interface QueueAdapter {
  send(client: pg.ClientBase, queue: string, group: string, body: unknown): Promise<string>;
  receive(queue: string, max: number, visibilityMs: number): Promise<QueueMessage[]>;
  delete(message: QueueMessage): Promise<void>;
  /** Makes the message visible again after `delayMs` (retry with backoff). */
  release(message: QueueMessage, delayMs: number, errorCode: string): Promise<void>;
  depth(queue: string): Promise<number>;
}

export class PostgresQueue implements QueueAdapter {
  /** @param pool the hos_relay pool (the queue table is a system table, §3.1). */
  constructor(private readonly pool: pg.Pool) {}

  async send(client: pg.ClientBase, queue: string, group: string, body: unknown): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO eventing.queue_message (id, queue, message_group, body, enqueued_at, visible_at)
       VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp())`,
      [id, queue, group, JSON.stringify(body)],
    );
    return id;
  }

  async receive(queue: string, max: number, visibilityMs: number): Promise<QueueMessage[]> {
    const result = await this.pool.query<{
      id: string;
      queue: string;
      message_group: string;
      body: unknown;
      receive_count: number;
      receipt: string;
      enqueued_at: Date;
    }>(
      `UPDATE eventing.queue_message AS m
          SET receipt = gen_random_uuid(), visible_at = clock_timestamp() + ($3 || ' milliseconds')::interval,
              receive_count = m.receive_count + 1
        WHERE m.id IN (
          SELECT h.id FROM eventing.queue_message AS h
           WHERE h.queue = $1 AND h.visible_at <= clock_timestamp()
             AND NOT EXISTS (SELECT 1 FROM eventing.queue_message AS o
                              WHERE o.queue = h.queue AND o.message_group = h.message_group
                                AND (o.enqueued_at, o.id) < (h.enqueued_at, h.id))
           ORDER BY h.enqueued_at, h.id
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING m.id, m.queue, m.message_group, m.body, m.receive_count, m.receipt, m.enqueued_at`,
      [queue, max, String(visibilityMs)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      group: row.message_group,
      body: row.body,
      receiveCount: row.receive_count,
      receipt: row.receipt,
      enqueuedAt: row.enqueued_at,
    }));
  }

  async delete(message: QueueMessage): Promise<void> {
    await this.pool.query('DELETE FROM eventing.queue_message WHERE id = $1 AND receipt = $2', [
      message.id,
      message.receipt,
    ]);
  }

  async release(message: QueueMessage, delayMs: number, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE eventing.queue_message SET visible_at = clock_timestamp() + ($3 || ' milliseconds')::interval, last_error = $4
        WHERE id = $1 AND receipt = $2`,
      [
        message.id,
        message.receipt,
        String(Math.max(0, Math.round(delayMs))),
        /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : 'handler_failed',
      ],
    );
  }

  async depth(queue: string): Promise<number> {
    const result = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM eventing.queue_message WHERE queue = $1',
      [queue],
    );
    return result.rows[0]?.n ?? 0;
  }
}

/** Exponential backoff with full jitter (technical architecture §7), capped. */
export function backoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}
