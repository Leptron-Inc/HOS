import { isUuid, uuidv7 } from '../ids.js';
import {
  ACTOR_REALMS,
  ContextMissingError,
  type ActorId,
  type EntryPoint,
  type OrganizationId,
  type PropertyId,
  type PropertyScope,
  type RequestContext,
  type VerifiedActor,
} from './request-context.js';

/**
 * The only way to create a RequestContext (CX-01). Only trusted entry points may import this file
 * (API pipeline, event consumer, scheduler, webhook receiver, provisioning); an architecture rule
 * in .dependency-cruiser.cjs enforces that. Every value here must already be verified by the
 * caller: the actor by credential verification and principal resolution, the tenant by the
 * lookups and the P2 authorization check (map §7.1, CX-06).
 */
export interface ContextInput {
  readonly entryPoint: EntryPoint;
  readonly actor: {
    readonly id: string;
    readonly realm: VerifiedActor['realm'];
    readonly kind: VerifiedActor['kind'];
  };
  readonly onBehalfOf?: {
    readonly id: string;
    readonly realm: VerifiedActor['realm'];
    readonly kind: VerifiedActor['kind'];
  } | null;
  readonly organizationId: string;
  readonly properties:
    | { readonly kind: 'all_in_organization' }
    | { readonly kind: 'listed'; readonly propertyIds: readonly string[] };
  /** Server-generated; generated here when absent. Carried over from a trusted envelope otherwise. */
  readonly correlationId?: string;
  readonly causationId?: string | null;
  readonly requestId?: string;
  /** Untrusted, length-limited and sanitized before it is recorded. */
  readonly clientCorrelationId?: string | null;
}

const MAX_CLIENT_CORRELATION = 128;

function sanitizeClientCorrelation(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, MAX_CLIENT_CORRELATION);
  return cleaned === '' ? null : cleaned;
}

function actor(input: ContextInput['actor'], field: string): VerifiedActor {
  if (!isUuid(input.id)) throw new ContextMissingError(`${field}.id is not a UUID`);
  if (!ACTOR_REALMS.includes(input.realm))
    throw new ContextMissingError(`${field}.realm is not a cell realm`);
  return { id: input.id as ActorId, realm: input.realm, kind: input.kind };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function createRequestContext(input: ContextInput): RequestContext {
  if (!isUuid(input.organizationId)) throw new ContextMissingError('organizationId is not a UUID');
  let properties: PropertyScope;
  if (input.properties.kind === 'all_in_organization') {
    properties = { kind: 'all_in_organization' };
  } else {
    for (const id of input.properties.propertyIds) {
      if (!isUuid(id)) throw new ContextMissingError('a listed property ID is not a UUID');
    }
    properties = {
      kind: 'listed',
      propertyIds: [...new Set(input.properties.propertyIds)] as PropertyId[],
    };
  }
  const correlationId = input.correlationId ?? uuidv7();
  if (!isUuid(correlationId)) throw new ContextMissingError('correlationId is not a UUID');
  const clientCorrelation = sanitizeClientCorrelation(input.clientCorrelationId);
  const context: RequestContext = {
    requestId: input.requestId ?? uuidv7(),
    correlationId,
    clientCorrelationId: clientCorrelation === null ? null : { untrusted: clientCorrelation },
    causationId: input.causationId ?? null,
    entryPoint: input.entryPoint,
    actor: actor(input.actor, 'actor'),
    onBehalfOf: input.onBehalfOf ? actor(input.onBehalfOf, 'onBehalfOf') : null,
    tenant: { organizationId: input.organizationId as OrganizationId, properties },
  };
  return deepFreeze(context);
}
