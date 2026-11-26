import { uuidv5 } from '../../../kernel/public.js';

/**
 * Evaluated permissions of one principal in one organization (CX-07). Built only from HOS-owned
 * role assignments (D-021); token claims never contribute (CX-04).
 */
export interface Grant {
  readonly permissions: ReadonlySet<string>;
  /** null: organization-wide. */
  readonly propertyId: string | null;
  /** Set only together with propertyId (B-25). */
  readonly departmentId: string | null;
}

export interface AuthorizationTarget {
  readonly propertyId?: string | null;
  /** For changes to an existing resource: read from the LOCKED row, never from the caller (CX-07, CX-17). */
  readonly departmentId?: string | null;
}

export class PrincipalGrants {
  constructor(
    readonly organizationId: string,
    readonly actorId: string,
    readonly grants: readonly Grant[],
  ) {}

  get organizationWide(): boolean {
    return this.grants.some((grant) => grant.propertyId === null);
  }

  /** A-11, A-12: properties the principal may reach; 'all' only with an organization-wide assignment. */
  propertyScope():
    | { readonly kind: 'all_in_organization' }
    | { readonly kind: 'listed'; readonly propertyIds: readonly string[] } {
    if (this.organizationWide) return { kind: 'all_in_organization' };
    return {
      kind: 'listed',
      propertyIds: [
        ...new Set(this.grants.map((g) => g.propertyId).filter((p): p is string => p !== null)),
      ],
    };
  }

  coversProperty(propertyId: string): boolean {
    return this.organizationWide || this.grants.some((grant) => grant.propertyId === propertyId);
  }

  /**
   * CX-07: an organization-wide assignment covers everything in the organization; a property
   * assignment covers that property (any department); a department assignment covers only
   * resources whose department matches. Organization-level checks (no property) need an
   * organization-wide assignment.
   */
  allows(permission: string, target: AuthorizationTarget = {}): boolean {
    const propertyId = target.propertyId ?? null;
    const departmentId = target.departmentId ?? null;
    return this.grants.some((grant) => {
      if (!grant.permissions.has(permission)) return false;
      if (grant.propertyId === null) return true;
      if (propertyId === null || grant.propertyId !== propertyId) return false;
      if (grant.departmentId === null) return true;
      return departmentId !== null && grant.departmentId === departmentId;
    });
  }
}

/**
 * Cell platform service identities (map §1.2: cell machine identities for workers). They exist in
 * code, not in a tenant table, act only inside the context of the event or job they process
 * (CX-11, CX-13), and hold exactly the permissions listed here (CX-12, G6). They have no issuer, so
 * they can never authenticate over HTTP.
 */
const PLATFORM_NAMESPACE = '6f1d3c2a-5b7e-4f80-9a1c-2d3e4f5a6b7c';

export interface PlatformIdentity {
  readonly id: string;
  readonly name: string;
  readonly permissions: ReadonlySet<string>;
}

const platformIdentities = new Map<string, PlatformIdentity>();

export function definePlatformIdentity(
  name: string,
  permissions: readonly string[],
): PlatformIdentity {
  const id = uuidv5(PLATFORM_NAMESPACE, name);
  const existing = platformIdentities.get(id);
  if (existing !== undefined) {
    if ([...existing.permissions].sort().join(',') !== [...permissions].sort().join(',')) {
      throw new Error(`platform identity ${name} defined twice with different permissions`);
    }
    return existing;
  }
  const identity: PlatformIdentity = { id, name, permissions: new Set(permissions) };
  platformIdentities.set(id, identity);
  return identity;
}

export function platformIdentity(id: string): PlatformIdentity | undefined {
  return platformIdentities.get(id);
}
