import type pg from 'pg';

/**
 * Pre-tenant lookups (tenancy specification C-12, C-21, CX-06). These call only the allowlisted
 * SECURITY DEFINER functions; they return status values and IDs, never business data, and run
 * without any tenant context.
 */
export type LookupStatus = 'active' | 'inactive' | 'not_found';

function status(value: unknown): LookupStatus {
  return value === 'active' || value === 'inactive' ? value : 'not_found';
}

export interface WebhookEndpoint {
  readonly connector_instance_id: string;
  readonly organization_id: string;
  readonly property_id: string | null;
  readonly connector_type: string;
  readonly status: string;
  readonly credential_ref: string | null;
  readonly provider_account_id: string | null;
}

export class TenantLookup {
  constructor(private readonly pool: pg.Pool) {}

  async organizationStatus(organizationId: string): Promise<LookupStatus> {
    const result = await this.pool.query<{ s: string }>(
      'SELECT kernel.organization_status($1) AS s',
      [organizationId],
    );
    return status(result.rows[0]?.s);
  }

  async propertyStatus(organizationId: string, propertyId: string): Promise<LookupStatus> {
    const result = await this.pool.query<{ s: string }>(
      'SELECT kernel.property_status($1, $2) AS s',
      [organizationId, propertyId],
    );
    return status(result.rows[0]?.s);
  }

  /** The actor in the claimed organization for a verified (issuer, subject), if any. */
  async resolvePrincipal(
    organizationId: string,
    issuer: string,
    subject: string,
  ): Promise<{ actorId: string; status: LookupStatus } | undefined> {
    const result = await this.pool.query<{ actor_id: string; actor_status: string }>(
      'SELECT actor_id, actor_status FROM kernel.resolve_principal($1, $2, $3)',
      [organizationId, issuer, subject],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { actorId: row.actor_id, status: status(row.actor_status) };
  }

  /** P4 webhook endpoint lookup (C-21 allowlist row): the instance, its tenant and credential reference. */
  async webhookEndpoint(endpointId: string): Promise<WebhookEndpoint | undefined> {
    const result = await this.pool.query<WebhookEndpoint>(
      'SELECT connector_instance_id, organization_id, property_id, connector_type, status, credential_ref, provider_account_id FROM kernel.webhook_endpoint_lookup($1)',
      [endpointId],
    );
    return result.rows[0];
  }

  /** Organizations where the verified subject has an active user. Call only after verification (CX-10). */
  async listMemberships(issuer: string, subject: string): Promise<string[]> {
    const result = await this.pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM kernel.list_memberships($1, $2) AS organization_id',
      [issuer, subject],
    );
    return result.rows.map((row) => row.organization_id);
  }
}
