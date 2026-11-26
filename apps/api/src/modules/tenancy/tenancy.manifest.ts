import type { Generated, ModuleManifest } from '../../kernel/public.js';

/** P1 Multi-Tenant Architecture: table manifest (tenancy specification B-04 to B-07, E-26, E-30). */
export const TENANCY_MANIFEST: ModuleManifest = {
  module: 'tenant',
  prefix: 'tenant_',
  tables: [
    {
      table: 'app.tenant_organization',
      scope: 'organization',
      retention: 'operational',
      history: 'app.tenant_organization_history',
      columns: {
        id: 'internal',
        display_name: 'public',
        status: 'internal',
        version: 'internal',
        created_at: 'internal',
        created_by: 'internal',
        updated_at: 'internal',
        updated_by: 'internal',
      },
    },
    {
      table: 'app.tenant_property',
      scope: 'property',
      retention: 'operational',
      history: 'app.tenant_property_history',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        display_name: 'public',
        status: 'internal',
        version: 'internal',
        created_at: 'internal',
        created_by: 'internal',
        updated_at: 'internal',
        updated_by: 'internal',
      },
    },
    {
      table: 'app.tenant_department',
      scope: 'property',
      retention: 'operational',
      history: 'app.tenant_department_history',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        property_id: 'internal',
        code: 'internal',
        name: 'internal',
        status: 'internal',
        version: 'internal',
        created_at: 'internal',
        created_by: 'internal',
        updated_at: 'internal',
        updated_by: 'internal',
      },
    },
    {
      table: 'app.tenant_idempotency_key',
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
        response_body: 'personal',
        created_at: 'internal',
        completed_at: 'internal',
        expires_at: 'internal',
      },
    },
  ],
};

/** Kysely table types for P1. */
export interface TenancyTables {
  'app.tenant_organization': {
    id: string;
    display_name: string;
    status: 'active' | 'inactive';
    version: Generated<number>;
    created_at: Generated<Date>;
    created_by: string;
    updated_at: Generated<Date>;
    updated_by: string;
  };
  'app.tenant_property': {
    id: string;
    organization_id: string;
    display_name: string;
    status: 'active' | 'inactive';
    version: Generated<number>;
    created_at: Generated<Date>;
    created_by: string;
    updated_at: Generated<Date>;
    updated_by: string;
  };
  'app.tenant_department': {
    id: string;
    organization_id: string;
    property_id: string;
    code: string;
    name: string;
    status: 'active' | 'inactive';
    version: Generated<number>;
    created_at: Generated<Date>;
    created_by: string;
    updated_at: Generated<Date>;
    updated_by: string;
  };
  'app.tenant_department_history': {
    organization_id: string;
    property_id: string;
    entity_id: string;
    version: number;
    recorded_at: Date;
    correlation_id: string;
    actor_id: string;
    code: string;
    name: string;
    status: string;
    erased_at: Date | null;
    erasure_reason: string | null;
    erasure_reference: string | null;
  };
}
