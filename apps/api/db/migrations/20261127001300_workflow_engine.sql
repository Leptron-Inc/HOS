-- P3 Event & Workflow Engine services (layer L3): workflow definitions, instances, execution
-- history, approvals and scheduled tasks (module map P3; technical architecture §5: state machines
-- stored in the database first). Basis: tenancy specification B-09, B-10, B-13, C-03, C-04, CX-13.
-- PROVISIONAL (Phase 1): entity names follow the module map's proposed names; the events
-- specification will confirm them. hos_relay lists due work across tenants with column-level
-- SELECT only (CX-13); every change runs in a tenant transaction.

-- The relay lists due work across tenants (CX-13): schema usage plus column-level SELECT below.
GRANT USAGE ON SCHEMA app TO hos_relay;

CREATE TABLE app.wf_definition (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL REFERENCES app.tenant_organization (id),
  code             text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  definition_version integer   NOT NULL CHECK (definition_version >= 1),
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  steps            jsonb       NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 50),
  -- Optional domain event that starts an instance (never a workflow.* event, to prevent loops).
  trigger_event    text        CHECK (trigger_event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$' AND trigger_event NOT LIKE 'workflow.%'),
  status           text        NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code, definition_version)
);
CREATE INDEX wf_definition_trigger_idx ON app.wf_definition (organization_id, trigger_event) WHERE status = 'published';
CALL hos_migration.enable_tenant_rls('app.wf_definition', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.wf_definition TO hos_app;

CREATE TABLE app.wf_instance (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  property_id      uuid,                    -- attribute (authorization of approvals); isolation is by organization
  definition_id    uuid        NOT NULL,
  state            text        NOT NULL CHECK (state IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  current_step     integer     NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  attempt          integer     NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_run_at      timestamptz,
  lease_until      timestamptz,
  input            jsonb       NOT NULL,
  outputs          jsonb       NOT NULL DEFAULT '{}',
  initiated_by     uuid        NOT NULL,
  initiated_realm  text        NOT NULL CHECK (initiated_realm IN ('hotel_employee', 'guest', 'machine')),
  initiated_kind   text        NOT NULL CHECK (initiated_kind IN ('user', 'service_identity', 'support_session')),
  last_error       text        CHECK (last_error ~ '^[a-z][a-z0-9_.]{0,63}$'),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, definition_id) REFERENCES app.wf_definition (organization_id, id),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CREATE INDEX wf_instance_definition_idx ON app.wf_instance (organization_id, definition_id);
CREATE INDEX wf_instance_property_idx   ON app.wf_instance (organization_id, property_id);
CREATE INDEX wf_instance_state_idx      ON app.wf_instance (organization_id, state, created_at);
-- System due-work scan (CX-13; B-13 exception, listed in the manifest).
CREATE INDEX wf_instance_due_idx ON app.wf_instance (next_run_at) WHERE state IN ('pending', 'running');
CALL hos_migration.enable_tenant_rls('app.wf_instance', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.wf_instance TO hos_app;
CREATE POLICY relay_access ON app.wf_instance AS PERMISSIVE FOR ALL TO hos_relay USING (true) WITH CHECK (false);
GRANT SELECT (id, organization_id, state, next_run_at, lease_until) ON app.wf_instance TO hos_relay;

-- Execution history: append-only (C-04), one row per step attempt outcome.
CREATE TABLE app.wf_step_execution (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  instance_id      uuid        NOT NULL,
  step_index       integer     NOT NULL CHECK (step_index >= 0),
  step_key         text        NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  attempt          integer     NOT NULL CHECK (attempt >= 1),
  outcome          text        NOT NULL CHECK (outcome IN ('started', 'succeeded', 'retrying', 'failed', 'waiting_approval', 'approved', 'rejected', 'denied', 'cancelled')),
  error_code       text        CHECK (error_code ~ '^[a-z][a-z0-9_.]{0,63}$'),
  actor_id         uuid        NOT NULL,
  on_behalf_of_id  uuid,
  correlation_id   uuid        NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, instance_id) REFERENCES app.wf_instance (organization_id, id)
);
CREATE INDEX wf_step_execution_instance_idx ON app.wf_step_execution (organization_id, instance_id, recorded_at);
CALL hos_migration.enable_tenant_rls('app.wf_step_execution', 'organization');
GRANT SELECT, INSERT ON app.wf_step_execution TO hos_app;

CREATE TABLE app.wf_approval_request (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  instance_id      uuid        NOT NULL,
  property_id      uuid,
  step_key         text        NOT NULL,
  approval_type    text        NOT NULL CHECK (approval_type ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  status           text        NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  decided_by       uuid,
  decided_at       timestamptz,
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, instance_id) REFERENCES app.wf_instance (organization_id, id),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX wf_approval_request_instance_idx ON app.wf_approval_request (organization_id, instance_id);
CREATE INDEX wf_approval_request_property_idx ON app.wf_approval_request (organization_id, property_id);
CREATE INDEX wf_approval_request_status_idx   ON app.wf_approval_request (organization_id, status, requested_at);
CALL hos_migration.enable_tenant_rls('app.wf_approval_request', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.wf_approval_request TO hos_app;

CREATE TABLE app.wf_scheduled_task (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  property_id      uuid,
  code             text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  definition_code  text        NOT NULL,
  interval_seconds integer     NOT NULL CHECK (interval_seconds BETWEEN 60 AND 31536000),
  input            jsonb       NOT NULL,
  next_run_at      timestamptz NOT NULL,
  last_run_at      timestamptz,
  status           text        NOT NULL CHECK (status IN ('active', 'paused')),
  owner_id         uuid        NOT NULL,
  owner_realm      text        NOT NULL CHECK (owner_realm IN ('hotel_employee', 'guest', 'machine')),
  owner_kind       text        NOT NULL CHECK (owner_kind IN ('user', 'service_identity', 'support_session')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CREATE INDEX wf_scheduled_task_property_idx ON app.wf_scheduled_task (organization_id, property_id);
CREATE INDEX wf_scheduled_task_due_idx ON app.wf_scheduled_task (next_run_at) WHERE status = 'active';
CALL hos_migration.enable_tenant_rls('app.wf_scheduled_task', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.wf_scheduled_task TO hos_app;
CREATE POLICY relay_access ON app.wf_scheduled_task AS PERMISSIVE FOR ALL TO hos_relay USING (true) WITH CHECK (false);
GRANT SELECT (id, organization_id, status, next_run_at) ON app.wf_scheduled_task TO hos_relay;

CREATE TABLE app.wf_idempotency_key (
  organization_id      uuid        NOT NULL REFERENCES app.tenant_organization (id),
  actor_id             uuid        NOT NULL,
  operation            text        NOT NULL,
  idempotency_key      text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_fingerprint  bytea       NOT NULL CHECK (length(request_fingerprint) = 32),
  response_status      smallint,
  response_headers     jsonb,
  response_body        jsonb,
  created_at           timestamptz NOT NULL,
  completed_at         timestamptz,
  expires_at           timestamptz NOT NULL,
  PRIMARY KEY (organization_id, actor_id, operation, idempotency_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX wf_idempotency_key_expiry_idx ON app.wf_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.wf_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.wf_idempotency_key TO hos_app;
GRANT DELETE ON app.wf_idempotency_key TO hos_worker;
