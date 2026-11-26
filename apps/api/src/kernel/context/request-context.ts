/**
 * Trusted request and actor context (tenancy specification §4.1; module map §7.1). The types are
 * the specification's, with the branded identifiers of E-04. Values of this type are created only
 * by context-factory.ts (CX-01) and are deep-frozen (CX-02).
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type PropertyId = Brand<string, 'PropertyId'>;
export type DepartmentId = Brand<string, 'DepartmentId'>;
export type ActorId = Brand<string, 'ActorId'>;

/** A value supplied by the caller and recorded for tracing only; never used for authorization. */
export type Untrusted<T> = { readonly untrusted: T };

/** Realm 1 (Leptron employees) never exists in a cell (map §1.2). */
export type ActorRealm = 'hotel_employee' | 'guest' | 'machine';
export const ACTOR_REALMS: readonly ActorRealm[] = ['hotel_employee', 'guest', 'machine'];

export interface VerifiedActor {
  readonly id: ActorId;
  readonly realm: ActorRealm;
  readonly kind: 'user' | 'service_identity' | 'support_session';
}

export type PropertyScope =
  | { readonly kind: 'all_in_organization' }
  | { readonly kind: 'listed'; readonly propertyIds: readonly PropertyId[] };

export type EntryPoint = 'api' | 'event_consumer' | 'scheduled_task' | 'webhook' | 'provisioning';

export interface RequestContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly clientCorrelationId: Untrusted<string> | null;
  readonly causationId: string | null;
  readonly entryPoint: EntryPoint;
  readonly actor: VerifiedActor;
  readonly onBehalfOf: VerifiedActor | null;
  readonly tenant: { readonly organizationId: OrganizationId; readonly properties: PropertyScope };
}

export class ContextMissingError extends Error {
  constructor(reason: string) {
    super(`Tenant context missing or incomplete: ${reason}`);
    this.name = 'ContextMissingError';
  }
}
