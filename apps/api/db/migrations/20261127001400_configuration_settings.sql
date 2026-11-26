-- P8 Configuration & Settings (module map P8; D-012 regional templates and controlled change;
-- tenancy specification E-11, E-43 provenance, A-09, B-09, B-10, E-20).
-- Layers of a setting's value, most specific first: property override (effective-dated) ->
-- organization override -> the property's template snapshot (delivered by provisioning, immutable)
-- -> the platform default in code. Override rules and value schemas are defined in code.
-- PROVISIONAL (Phase 1): the configuration specification is not written yet; names follow the module
-- map's proposed entities. Template publication by the Control Plane reaches the cell only as the
-- provisioning "configuration snapshot" (CX-15) until the Control Plane-cell contract exists.

-- Immutable template snapshots per property (append-only, C-04).
CREATE TABLE app.cfg_template_snapshot (
  id                uuid        PRIMARY KEY,
  organization_id   uuid        NOT NULL,
  property_id       uuid        NOT NULL,
  template_code     text        NOT NULL CHECK (template_code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  template_version  integer     NOT NULL CHECK (template_version >= 1),
  setting_values    jsonb       NOT NULL CHECK (jsonb_typeof(setting_values) = 'object'),
  locked_keys       text[]      NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_id, id),
  UNIQUE (organization_id, property_id, template_code, template_version),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('app.cfg_template_snapshot', 'property');
GRANT SELECT, INSERT ON app.cfg_template_snapshot TO hos_app;

-- The property's configuration state: active snapshot and the configuration version (E-43).
CREATE TABLE app.cfg_property_state (
  id                    uuid        PRIMARY KEY,
  organization_id       uuid        NOT NULL,
  property_id           uuid        NOT NULL,
  active_snapshot_id    uuid,
  configuration_version uuid        NOT NULL,
  status                text        NOT NULL CHECK (status IN ('pending', 'active')),
  version               bigint      NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_id),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id),
  FOREIGN KEY (organization_id, property_id, active_snapshot_id) REFERENCES app.cfg_template_snapshot (organization_id, property_id, id)
);
CREATE INDEX cfg_property_state_snapshot_idx ON app.cfg_property_state (organization_id, property_id, active_snapshot_id);   -- B-16
CALL hos_migration.enable_tenant_rls('app.cfg_property_state', 'property');
GRANT SELECT, INSERT, UPDATE ON app.cfg_property_state TO hos_app;

CREATE TABLE app.cfg_organization_setting (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL REFERENCES app.tenant_organization (id),
  setting_key      text        NOT NULL CHECK (setting_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$'),
  setting_value    jsonb,                      -- NULL: the override is cleared (inherit)
  reason           text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, setting_key)
);
CALL hos_migration.enable_tenant_rls('app.cfg_organization_setting', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.cfg_organization_setting TO hos_app;

-- Property overrides are effective-dated: several rows per key, the latest effective one applies.
CREATE TABLE app.cfg_property_setting (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  property_id      uuid        NOT NULL,
  setting_key      text        NOT NULL CHECK (setting_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$'),
  setting_value    jsonb,
  effective_from   timestamptz NOT NULL,
  reason           text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_id, setting_key, effective_from),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('app.cfg_property_setting', 'property');
GRANT SELECT, INSERT, UPDATE ON app.cfg_property_setting TO hos_app;

-- Change history (E-20): every value a setting override ever had, with actor and correlation.
CREATE TABLE app.cfg_organization_setting_history (
  organization_id uuid NOT NULL, entity_id uuid NOT NULL, version bigint NOT NULL,
  recorded_at timestamptz NOT NULL, correlation_id uuid NOT NULL, actor_id uuid NOT NULL,
  setting_key text NOT NULL, setting_value jsonb, reason text NOT NULL,
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.cfg_organization_setting_history', 'organization', false, '{}');
GRANT SELECT ON app.cfg_organization_setting_history TO hos_app;
GRANT INSERT ON app.cfg_organization_setting_history TO hos_history_writer;

CREATE TABLE app.cfg_property_setting_history (
  organization_id uuid NOT NULL, property_id uuid NOT NULL, entity_id uuid NOT NULL, version bigint NOT NULL,
  recorded_at timestamptz NOT NULL, correlation_id uuid NOT NULL, actor_id uuid NOT NULL,
  setting_key text NOT NULL, setting_value jsonb, effective_from timestamptz NOT NULL, reason text NOT NULL,
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.cfg_property_setting_history', 'property', false, '{}');
GRANT SELECT ON app.cfg_property_setting_history TO hos_app;
GRANT INSERT ON app.cfg_property_setting_history TO hos_history_writer;

SET ROLE hos_history_writer;          -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.cfg_organization_setting_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.cfg_organization_setting_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id, setting_key, setting_value, reason)
  VALUES
    (NEW.organization_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.setting_key, NEW.setting_value, NEW.reason);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.cfg_organization_setting_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.cfg_organization_setting_capture_version() TO hos_owner;

CREATE FUNCTION kernel.cfg_property_setting_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.cfg_property_setting_history
    (organization_id, property_id, entity_id, version, recorded_at, correlation_id, actor_id, setting_key, setting_value, effective_from, reason)
  VALUES
    (NEW.organization_id, NEW.property_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.setting_key, NEW.setting_value, NEW.effective_from, NEW.reason);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.cfg_property_setting_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.cfg_property_setting_capture_version() TO hos_owner;
SET ROLE hos_owner;

CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.cfg_organization_setting
  FOR EACH ROW EXECUTE FUNCTION kernel.cfg_organization_setting_capture_version();
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.cfg_property_setting
  FOR EACH ROW EXECUTE FUNCTION kernel.cfg_property_setting_capture_version();

CREATE TABLE app.cfg_idempotency_key (
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
CREATE INDEX cfg_idempotency_key_expiry_idx ON app.cfg_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.cfg_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.cfg_idempotency_key TO hos_app;
GRANT DELETE ON app.cfg_idempotency_key TO hos_worker;
