import type { Generated, ModuleManifest } from '../../kernel/public.js';

const versioned = {
  version: 'internal',
  created_at: 'internal',
  created_by: 'internal',
  updated_at: 'internal',
  updated_by: 'internal',
} as const;

/** P4 Integration Hub: table manifest (B-05). Secrets never appear here (E-26): only references. */
export const INTEGRATION_MANIFEST: ModuleManifest = {
  module: 'int',
  prefix: 'int_',
  tables: [
    {
      table: 'app.int_connector_instance',
      scope: 'organization',
      retention: 'operational',
      history: 'app.int_connector_instance_history',
      lookupIndexes: ['int_connector_instance_webhook_endpoint_id_key'],
      columns: {
        id: 'internal',
        organization_id: 'internal',
        scope_level: 'internal',
        property_id: 'internal',
        connector_type: 'internal',
        connector_version: 'internal',
        display_name: 'internal',
        status: 'internal',
        settings: 'internal',
        credential_ref: 'internal',
        webhook_endpoint_id: 'internal',
        provider_account_id: 'internal',
        last_health_status: 'internal',
        last_health_at: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.int_webhook_receipt',
      scope: 'organization',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        connector_instance_id: 'internal',
        provider_event_id: 'internal',
        raw_payload: 'personal',
        content_type: 'internal',
        received_at: 'internal',
        status: 'internal',
      },
    },
    {
      table: 'app.int_integration_log',
      scope: 'organization',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        connector_instance_id: 'internal',
        direction: 'internal',
        operation: 'internal',
        outcome: 'internal',
        status_code: 'internal',
        attempt: 'internal',
        duration_ms: 'internal',
        error_code: 'internal',
        recorded_at: 'internal',
      },
    },
    {
      table: 'app.int_idempotency_key',
      scope: 'organization',
      retention: 'transient',
      deletableBy: ['hos_worker'],
      columns: {
        organization_id: 'internal',
        actor_id: 'internal',
        operation: 'internal',
        idempotency_key: 'internal',
        request_fingerprint: 'internal',
        response_status: 'internal',
        response_headers: 'internal',
        response_body: 'internal',
        created_at: 'internal',
        completed_at: 'internal',
        expires_at: 'internal',
      },
    },
  ],
};

interface Versioned {
  version: Generated<number>;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  updated_by: string;
}
export type InstanceStatus =
  'configured' | 'verified' | 'active' | 'suspended' | 'error' | 'retired';

export interface IntegrationTables {
  'app.int_connector_instance': Versioned & {
    id: string;
    organization_id: string;
    scope_level: 'organization' | 'property';
    property_id: string | null;
    connector_type: string;
    connector_version: number;
    display_name: string;
    status: InstanceStatus;
    settings: unknown;
    credential_ref: string | null;
    webhook_endpoint_id: string;
    provider_account_id: string | null;
    last_health_status: 'healthy' | 'unhealthy' | null;
    last_health_at: Date | null;
  };
  'app.int_webhook_receipt': {
    id: string;
    organization_id: string;
    connector_instance_id: string;
    provider_event_id: string;
    raw_payload: Buffer;
    content_type: string;
    received_at: Generated<Date>;
    status: 'received' | 'processed' | 'failed';
  };
  'app.int_integration_log': {
    id: string;
    organization_id: string;
    connector_instance_id: string;
    direction: 'outbound' | 'inbound' | 'health';
    operation: string;
    outcome: 'success' | 'failure' | 'retry' | 'rejected' | 'duplicate';
    status_code: number | null;
    attempt: number;
    duration_ms: number;
    error_code: string | null;
    recorded_at: Generated<Date>;
  };
}
