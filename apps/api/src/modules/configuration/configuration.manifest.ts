import type { Generated, ModuleManifest } from '../../kernel/public.js';

const versioned = {
  version: 'internal',
  created_at: 'internal',
  created_by: 'internal',
  updated_at: 'internal',
  updated_by: 'internal',
} as const;

/** P8 Configuration & Settings: table manifest (B-05). Setting values are internal configuration, never secrets. */
export const CONFIGURATION_MANIFEST: ModuleManifest = {
  module: 'cfg',
  prefix: 'cfg_',
  tables: [
    {
      table: 'app.cfg_template_snapshot',
      scope: 'property',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        property_id: 'internal',
        template_code: 'internal',
        template_version: 'internal',
        setting_values: 'internal',
        locked_keys: 'internal',
        created_at: 'internal',
        created_by: 'internal',
      },
    },
    {
      table: 'app.cfg_property_state',
      scope: 'property',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        property_id: 'internal',
        active_snapshot_id: 'internal',
        configuration_version: 'internal',
        status: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.cfg_organization_setting',
      scope: 'organization',
      retention: 'operational',
      history: 'app.cfg_organization_setting_history',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        setting_key: 'internal',
        setting_value: 'internal',
        reason: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.cfg_property_setting',
      scope: 'property',
      retention: 'operational',
      history: 'app.cfg_property_setting_history',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        property_id: 'internal',
        setting_key: 'internal',
        setting_value: 'internal',
        effective_from: 'internal',
        reason: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.cfg_idempotency_key',
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

export interface ConfigurationTables {
  'app.cfg_template_snapshot': {
    id: string;
    organization_id: string;
    property_id: string;
    template_code: string;
    template_version: number;
    setting_values: unknown;
    locked_keys: Generated<string[]>;
    created_at: Generated<Date>;
    created_by: string;
  };
  'app.cfg_property_state': Versioned & {
    id: string;
    organization_id: string;
    property_id: string;
    active_snapshot_id: string | null;
    configuration_version: string;
    status: 'pending' | 'active';
  };
  'app.cfg_organization_setting': Versioned & {
    id: string;
    organization_id: string;
    setting_key: string;
    setting_value: unknown;
    reason: string;
  };
  'app.cfg_property_setting': Versioned & {
    id: string;
    organization_id: string;
    property_id: string;
    setting_key: string;
    setting_value: unknown;
    effective_from: Date;
    reason: string;
  };
  'app.cfg_organization_setting_history': {
    organization_id: string;
    entity_id: string;
    version: number;
    recorded_at: Date;
    correlation_id: string;
    actor_id: string;
    setting_key: string;
    setting_value: unknown;
    reason: string;
  };
  'app.cfg_property_setting_history': {
    organization_id: string;
    property_id: string;
    entity_id: string;
    version: number;
    recorded_at: Date;
    correlation_id: string;
    actor_id: string;
    setting_key: string;
    setting_value: unknown;
    effective_from: Date;
    reason: string;
  };
}
