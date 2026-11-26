import type { z } from 'zod';

/**
 * Event contracts and versioning (P3; module map G4; technical architecture §5 envelope).
 * Every event type is registered with its version and a payload schema before it can be published
 * or consumed. A breaking payload change is a new version; consumers declare the versions they
 * accept. PROVISIONAL: the events specification will own the final envelope and registry rules.
 */
export interface EventContract<TPayload = unknown> {
  readonly type: string;
  readonly version: number;
  readonly schema: z.ZodType<TPayload>;
  /** Payload fields that hold personal data (minimized; never logged). */
  readonly personalFields?: readonly string[];
}

/** The envelope delivered to consumers (technical architecture §5; tenancy specification CX-11). */
export interface EventEnvelope<TPayload = unknown> {
  readonly event_id: string;
  readonly type: string;
  readonly version: number;
  readonly organization_id: string;
  readonly property_id: string | null;
  readonly occurred_at: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly actor: {
    readonly id: string;
    readonly realm: 'hotel_employee' | 'guest' | 'machine';
    readonly kind: 'user' | 'service_identity' | 'support_session';
  };
  readonly on_behalf_of_id: string | null;
  readonly ordering_key: string;
  readonly payload: TPayload;
}

const TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;
const registry = new Map<string, EventContract>();

export class EventContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventContractError';
  }
}

export function defineEvent<TPayload>(contract: EventContract<TPayload>): EventContract<TPayload> {
  if (!TYPE_PATTERN.test(contract.type))
    throw new EventContractError(`invalid event type ${contract.type}`);
  if (!Number.isInteger(contract.version) || contract.version < 1)
    throw new EventContractError('event version must be >= 1');
  const key = `${contract.type}@${contract.version}`;
  const existing = registry.get(key);
  if (existing !== undefined && existing !== contract)
    throw new EventContractError(`event contract ${key} registered twice`);
  registry.set(key, contract);
  return contract;
}

export function eventContract(type: string, version: number): EventContract | undefined {
  return registry.get(`${type}@${version}`);
}

export function registeredEventContracts(): readonly EventContract[] {
  return [...registry.values()];
}
