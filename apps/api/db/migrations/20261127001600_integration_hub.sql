-- P4 Integration Hub framework (module map P4; D-012 connector lifecycle; technical architecture §7;
-- tenancy specification CX-14 webhooks, C-21 P4 lookup row, E-26 secrets never in tenant tables).
-- PROVISIONAL (Phase 1): the P4 specification (connector contracts, U-007 mappings, U-018 credential
-- ownership) is not written yet. Connector instances are organization-scoped tables with an explicit
-- scope level and an optional property (A-09, second option; Q-16 direction from founder review).

GRANT USAGE ON SCHEMA app TO hos_lookup_integration;
GRANT USAGE, CREATE ON SCHEMA kernel TO hos_lookup_integration;

CREATE TABLE app.int_connector_instance (
  id                   uuid        PRIMARY KEY,
  organization_id      uuid        NOT NULL REFERENCES app.tenant_organization (id),
  scope_level          text        NOT NULL CHECK (scope_level IN ('organization', 'property')),
  property_id          uuid,
  connector_type       text        NOT NULL CHECK (connector_type ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  connector_version    integer     NOT NULL CHECK (connector_version >= 1),
  display_name         text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status               text        NOT NULL CHECK (status IN ('configured', 'verified', 'active', 'suspended', 'error', 'retired')),
  settings             jsonb       NOT NULL,                -- non-secret configuration only
  credential_ref       text        CHECK (credential_ref ~ '^[a-z]+:[A-Za-z0-9._/-]{1,200}$'),   -- a reference, never the secret
  webhook_endpoint_id  text        NOT NULL UNIQUE CHECK (webhook_endpoint_id ~ '^[A-Za-z0-9_-]{43}$'),
  provider_account_id  text        CHECK (length(provider_account_id) BETWEEN 1 AND 200),
  last_health_status   text        CHECK (last_health_status IN ('healthy', 'unhealthy')),
  last_health_at       timestamptz,
  version              bigint      NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NOT NULL,
  UNIQUE (organization_id, id),
  CHECK ((scope_level = 'property') = (property_id IS NOT NULL)),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CREATE INDEX int_connector_instance_property_idx ON app.int_connector_instance (organization_id, property_id);
CALL hos_migration.enable_tenant_rls('app.int_connector_instance', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.int_connector_instance TO hos_app;
-- Pre-tenant webhook lookup (C-21): named columns only, SELECT-only policy for the lookup owner.
GRANT SELECT (id, organization_id, property_id, connector_type, status, credential_ref, webhook_endpoint_id, provider_account_id)
  ON app.int_connector_instance TO hos_lookup_integration;
CREATE POLICY kernel_lookup ON app.int_connector_instance AS PERMISSIVE FOR SELECT TO hos_lookup_integration USING (true);

CREATE TABLE app.int_connector_instance_history (
  organization_id uuid NOT NULL, entity_id uuid NOT NULL, version bigint NOT NULL,
  recorded_at timestamptz NOT NULL, correlation_id uuid NOT NULL, actor_id uuid NOT NULL,
  connector_type text NOT NULL, connector_version integer NOT NULL, status text NOT NULL, settings jsonb NOT NULL,
  credential_ref text, scope_level text NOT NULL, property_id uuid,
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.int_connector_instance_history', 'organization', false, '{}');
GRANT SELECT ON app.int_connector_instance_history TO hos_app;
GRANT INSERT ON app.int_connector_instance_history TO hos_history_writer;
CREATE POLICY monitor_read ON app.int_connector_instance_history AS PERMISSIVE FOR SELECT TO hos_monitor USING (true);
GRANT SELECT (organization_id, entity_id, version, recorded_at) ON app.int_connector_instance_history TO hos_monitor;

SET ROLE hos_history_writer;          -- C-19
CREATE FUNCTION kernel.int_connector_instance_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.int_connector_instance_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id, connector_type, connector_version, status,
     settings, credential_ref, scope_level, property_id)
  VALUES
    (NEW.organization_id, NEW.id, NEW.version, now(), current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.connector_type, NEW.connector_version, NEW.status, NEW.settings, NEW.credential_ref, NEW.scope_level, NEW.property_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.int_connector_instance_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.int_connector_instance_capture_version() TO hos_owner;

SET ROLE hos_lookup_integration;      -- C-19, C-21: the P4 webhook endpoint lookup
CREATE FUNCTION kernel.webhook_endpoint_lookup(p_endpoint_id text)
RETURNS TABLE (connector_instance_id uuid, organization_id uuid, property_id uuid, connector_type text, status text,
               credential_ref text, provider_account_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.id, c.organization_id, c.property_id, c.connector_type, c.status, c.credential_ref, c.provider_account_id
    FROM app.int_connector_instance AS c
   WHERE c.webhook_endpoint_id = p_endpoint_id
$$;
REVOKE ALL ON FUNCTION kernel.webhook_endpoint_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.webhook_endpoint_lookup(text) TO hos_app;
SET ROLE hos_owner;

CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.int_connector_instance
  FOR EACH ROW EXECUTE FUNCTION kernel.int_connector_instance_capture_version();

-- Inbound webhook receipts: the raw payload unchanged; one receipt per provider event (H-HOOK-05).
CREATE TABLE app.int_webhook_receipt (
  id                     uuid        PRIMARY KEY,
  organization_id        uuid        NOT NULL,
  connector_instance_id  uuid        NOT NULL,
  provider_event_id      text        NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  raw_payload            bytea       NOT NULL,
  content_type           text        NOT NULL CHECK (length(content_type) <= 200),
  received_at            timestamptz NOT NULL DEFAULT now(),
  status                 text        NOT NULL CHECK (status IN ('received', 'processed', 'failed')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, connector_instance_id, provider_event_id),
  FOREIGN KEY (organization_id, connector_instance_id) REFERENCES app.int_connector_instance (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('app.int_webhook_receipt', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.int_webhook_receipt TO hos_app;

-- Integration logs and diagnostics: outcomes and timings only; never credentials or payloads.
CREATE TABLE app.int_integration_log (
  id                     uuid        PRIMARY KEY,
  organization_id        uuid        NOT NULL,
  connector_instance_id  uuid        NOT NULL,
  direction              text        NOT NULL CHECK (direction IN ('outbound', 'inbound', 'health')),
  operation              text        NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  outcome                text        NOT NULL CHECK (outcome IN ('success', 'failure', 'retry', 'rejected', 'duplicate')),
  status_code            integer     CHECK (status_code BETWEEN 100 AND 599),
  attempt                integer     NOT NULL CHECK (attempt >= 1),
  duration_ms            integer     NOT NULL CHECK (duration_ms >= 0),
  error_code             text        CHECK (error_code ~ '^[a-z][a-z0-9_.]{0,63}$'),
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, connector_instance_id) REFERENCES app.int_connector_instance (organization_id, id)
);
CREATE INDEX int_integration_log_instance_idx ON app.int_integration_log (organization_id, connector_instance_id, recorded_at);
CALL hos_migration.enable_tenant_rls('app.int_integration_log', 'organization');
GRANT SELECT, INSERT ON app.int_integration_log TO hos_app;

CREATE TABLE app.int_idempotency_key (
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
CREATE INDEX int_idempotency_key_expiry_idx ON app.int_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.int_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.int_idempotency_key TO hos_app;
GRANT DELETE ON app.int_idempotency_key TO hos_worker;
