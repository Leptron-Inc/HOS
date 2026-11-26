import { SetMetadata } from '@nestjs/common';

/**
 * Every route declares its scope (tenancy specification CX-10). The application refuses to start
 * if a route has none (route-scope.check.ts, H-CTX-03).
 */
export const ROUTE_SCOPE = 'hos:route-scope';

export type RouteScope =
  | { readonly type: 'tenant'; readonly level: 'organization' | 'property' }
  | { readonly type: 'non_tenant'; readonly authenticated: boolean }
  | { readonly type: 'provisioning' }
  | { readonly type: 'webhook' };

/** `/v1/organizations/:organizationId/...` (level organization) or `.../properties/:propertyId/...`. */
export const TenantRoute = (level: 'organization' | 'property' = 'organization') =>
  SetMetadata(ROUTE_SCOPE, { type: 'tenant', level } satisfies RouteScope);

/** An explicit, short list of routes outside any tenant (health checks, /v1/me). */
export const NonTenantRoute = (authenticated: boolean) =>
  SetMetadata(ROUTE_SCOPE, { type: 'non_tenant', authenticated } satisfies RouteScope);

/** The cell's provisioning API: the Control Plane provisioning identity only (CX-15). */
export const ProvisioningRoute = () =>
  SetMetadata(ROUTE_SCOPE, { type: 'provisioning' } satisfies RouteScope);

/** Inbound webhooks: tenant from the connector-instance record, after signature verification (CX-14). */
export const WebhookRoute = () =>
  SetMetadata(ROUTE_SCOPE, { type: 'webhook' } satisfies RouteScope);
