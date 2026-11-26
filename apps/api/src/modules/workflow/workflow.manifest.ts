import type { Generated, ModuleManifest } from '../../kernel/public.js';

const versioned = {
  version: 'internal',
  created_at: 'internal',
  created_by: 'internal',
  updated_at: 'internal',
  updated_by: 'internal',
} as const;

/** P3 Event & Workflow Engine services: table manifest (B-05). */
export const WORKFLOW_MANIFEST: ModuleManifest = {
  module: 'workflow',
  prefix: 'wf_',
  auditRecords: {
    dead_letter_replay: { queue: 'internal', event_type: 'internal', status: 'internal' },
  },
  tables: [
    {
      table: 'app.wf_definition',
      scope: 'organization',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        code: 'internal',
        definition_version: 'internal',
        name: 'internal',
        steps: 'internal',
        trigger_event: 'internal',
        status: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.wf_instance',
      scope: 'organization',
      retention: 'operational',
      lookupIndexes: ['wf_instance_due_idx'],
      columns: {
        id: 'internal',
        organization_id: 'internal',
        property_id: 'internal',
        definition_id: 'internal',
        state: 'internal',
        current_step: 'internal',
        attempt: 'internal',
        next_run_at: 'internal',
        lease_until: 'internal',
        input: 'personal',
        outputs: 'personal',
        initiated_by: 'internal',
        initiated_realm: 'internal',
        initiated_kind: 'internal',
        last_error: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.wf_step_execution',
      scope: 'organization',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        instance_id: 'internal',
        step_index: 'internal',
        step_key: 'internal',
        attempt: 'internal',
        outcome: 'internal',
        error_code: 'internal',
        actor_id: 'internal',
        on_behalf_of_id: 'internal',
        correlation_id: 'internal',
        recorded_at: 'internal',
      },
    },
    {
      table: 'app.wf_approval_request',
      scope: 'organization',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        instance_id: 'internal',
        property_id: 'internal',
        step_key: 'internal',
        approval_type: 'internal',
        status: 'internal',
        requested_at: 'internal',
        decided_by: 'internal',
        decided_at: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.wf_scheduled_task',
      scope: 'organization',
      retention: 'operational',
      lookupIndexes: ['wf_scheduled_task_due_idx'],
      columns: {
        id: 'internal',
        organization_id: 'internal',
        property_id: 'internal',
        code: 'internal',
        definition_code: 'internal',
        interval_seconds: 'internal',
        input: 'personal',
        next_run_at: 'internal',
        last_run_at: 'internal',
        status: 'internal',
        owner_id: 'internal',
        owner_realm: 'internal',
        owner_kind: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.wf_idempotency_key',
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

interface Versioned {
  version: Generated<number>;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  updated_by: string;
}
type Realm = 'hotel_employee' | 'guest' | 'machine';
type Kind = 'user' | 'service_identity' | 'support_session';

export interface WorkflowTables {
  'app.wf_definition': Versioned & {
    id: string;
    organization_id: string;
    code: string;
    definition_version: number;
    name: string;
    steps: unknown;
    trigger_event: string | null;
    status: 'draft' | 'published' | 'retired';
  };
  'app.wf_instance': Versioned & {
    id: string;
    organization_id: string;
    property_id: string | null;
    definition_id: string;
    state: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
    current_step: Generated<number>;
    attempt: Generated<number>;
    next_run_at: Date | null;
    lease_until: Date | null;
    input: unknown;
    outputs: Generated<unknown>;
    initiated_by: string;
    initiated_realm: Realm;
    initiated_kind: Kind;
    last_error: string | null;
  };
  'app.wf_step_execution': {
    id: string;
    organization_id: string;
    instance_id: string;
    step_index: number;
    step_key: string;
    attempt: number;
    outcome:
      | 'started'
      | 'succeeded'
      | 'retrying'
      | 'failed'
      | 'waiting_approval'
      | 'approved'
      | 'rejected'
      | 'denied'
      | 'cancelled';
    error_code: string | null;
    actor_id: string;
    on_behalf_of_id: string | null;
    correlation_id: string;
    recorded_at: Generated<Date>;
  };
  'app.wf_approval_request': Versioned & {
    id: string;
    organization_id: string;
    instance_id: string;
    property_id: string | null;
    step_key: string;
    approval_type: string;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    requested_at: Generated<Date>;
    decided_by: string | null;
    decided_at: Date | null;
  };
  'app.wf_scheduled_task': Versioned & {
    id: string;
    organization_id: string;
    property_id: string | null;
    code: string;
    definition_code: string;
    interval_seconds: number;
    input: unknown;
    next_run_at: Date;
    last_run_at: Date | null;
    status: 'active' | 'paused';
    owner_id: string;
    owner_realm: Realm;
    owner_kind: Kind;
  };
}
