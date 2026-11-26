-- P1 Multi-Tenant Architecture: version history for organizations and properties (map §1.1, E-20,
-- E-21; same pattern as validated block 06) and the P1 idempotency store (F-08; shape of block 09).

CREATE TABLE app.tenant_organization_history (
  organization_id    uuid        NOT NULL,
  entity_id          uuid        NOT NULL,
  version            bigint      NOT NULL,
  recorded_at        timestamptz NOT NULL,
  correlation_id     uuid        NOT NULL,
  actor_id           uuid        NOT NULL,
  display_name       text        NOT NULL,
  status             text        NOT NULL,
  erased_at          timestamptz,
  erasure_reason     text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference  uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.tenant_organization_history', 'organization', false, '{}');
GRANT SELECT ON app.tenant_organization_history TO hos_app;
GRANT INSERT ON app.tenant_organization_history TO hos_history_writer;

CREATE TABLE app.tenant_property_history (
  organization_id    uuid        NOT NULL,
  property_id        uuid        NOT NULL,
  entity_id          uuid        NOT NULL,
  version            bigint      NOT NULL,
  recorded_at        timestamptz NOT NULL,
  correlation_id     uuid        NOT NULL,
  actor_id           uuid        NOT NULL,
  display_name       text        NOT NULL,
  status             text        NOT NULL,
  erased_at          timestamptz,
  erasure_reason     text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference  uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.tenant_property_history', 'property', false, '{}');
GRANT SELECT ON app.tenant_property_history TO hos_app;
GRANT INSERT ON app.tenant_property_history TO hos_history_writer;

SET ROLE hos_history_writer;          -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.tenant_organization_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.tenant_organization_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id, display_name, status)
  VALUES
    (NEW.id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid,   -- fails if the context is missing: fail closed
     current_setting('hos.actor_id')::uuid,
     NEW.display_name, NEW.status);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.tenant_organization_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.tenant_organization_capture_version() TO hos_owner;

CREATE FUNCTION kernel.tenant_property_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.tenant_property_history
    (organization_id, property_id, entity_id, version, recorded_at, correlation_id, actor_id,
     display_name, status)
  VALUES
    (NEW.organization_id, NEW.id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid,
     current_setting('hos.actor_id')::uuid,
     NEW.display_name, NEW.status);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.tenant_property_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.tenant_property_capture_version() TO hos_owner;
SET ROLE hos_owner;

CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.tenant_organization
  FOR EACH ROW EXECUTE FUNCTION kernel.tenant_organization_capture_version();
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.tenant_property
  FOR EACH ROW EXECUTE FUNCTION kernel.tenant_property_capture_version();

-- P1 idempotency store (F-08), shape of validated block 09.
CREATE TABLE app.tenant_idempotency_key (
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
CREATE INDEX tenant_idempotency_key_expiry_idx ON app.tenant_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.tenant_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.tenant_idempotency_key TO hos_app;
GRANT DELETE ON app.tenant_idempotency_key TO hos_worker;      -- purge job only (F-23)
