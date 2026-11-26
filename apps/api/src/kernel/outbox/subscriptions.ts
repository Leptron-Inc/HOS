import type { ModuleManifest } from '../database/manifest.js';
import type { TenantTx } from '../database/tenant-transaction.js';
import type { EventContract, EventEnvelope } from './event-contracts.js';

/**
 * Event subscriptions (P3; D-018; tenancy specification CX-11, CX-12). Each consumer is owned by
 * one module, has its own queue, declares the event types and versions it accepts, and declares
 * the permissions its service identity needs (checked on every handled event). The handler runs
 * inside the consumer module's tenant transaction, after the inbox claim.
 */
export interface Subscription<DB = unknown> {
  /** Consumer name; also its queue name and inbox key. */
  readonly name: string;
  readonly manifest: ModuleManifest;
  readonly events: readonly EventContract[];
  /** '*' subscribes to every registered event type (workflow triggers). */
  readonly allEvents?: boolean;
  readonly permissions: readonly string[];
  /** Deliveries before the message goes to the dead-letter path. */
  readonly maxReceives?: number;
  handle(envelope: EventEnvelope, tx: TenantTx<DB>): Promise<void>;
}

const subscriptions = new Map<string, Subscription>();

export function defineSubscription<DB>(subscription: Subscription<DB>): Subscription<DB> {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(subscription.name))
    throw new Error(`invalid consumer name ${subscription.name}`);
  // A process wires each consumer to its own service instances; re-registering a name replaces it.
  subscriptions.set(subscription.name, subscription as Subscription);
  return subscription;
}

export function registeredSubscriptions(): readonly Subscription[] {
  return [...subscriptions.values()];
}

/** The consumers an event is routed to. */
export function subscribersOf(type: string, version: number): readonly Subscription[] {
  return [...subscriptions.values()].filter(
    (s) =>
      s.allEvents === true ||
      s.events.some((contract) => contract.type === type && contract.version === version),
  );
}
