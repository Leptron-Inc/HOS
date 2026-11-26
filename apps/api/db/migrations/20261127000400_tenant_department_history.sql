-- P1 Multi-Tenant Architecture: department version history (E-20, E-21).
-- Source: tenancy specification rev 2.1, validated block 06, unchanged.
-- [validated 06 migration: P1 department history (non-sensitive example)]
CREATE TABLE app.tenant_department_history (
  organization_id    uuid        NOT NULL,
  property_id        uuid        NOT NULL,
  entity_id          uuid        NOT NULL,
  version            bigint      NOT NULL,
  recorded_at        timestamptz NOT NULL,
  correlation_id     uuid        NOT NULL,
  actor_id           uuid        NOT NULL,
  code               text        NOT NULL,
  name               text        NOT NULL,
  status             text        NOT NULL,
  erased_at          timestamptz,
  erasure_reason     text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference  uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.tenant_department_history', 'property', false, '{}');
GRANT SELECT ON app.tenant_department_history TO hos_app;
GRANT INSERT ON app.tenant_department_history TO hos_history_writer;

SET ROLE hos_history_writer;          -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.tenant_department_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.tenant_department_history
    (organization_id, property_id, entity_id, version, recorded_at,
     correlation_id, actor_id, code, name, status)
  VALUES
    (NEW.organization_id, NEW.property_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid,   -- fails if the context is missing: fail closed
     current_setting('hos.actor_id')::uuid,
     NEW.code, NEW.name, NEW.status);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.tenant_department_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.tenant_department_capture_version() TO hos_owner;   -- CREATE TRIGGER requires it (C-22)
SET ROLE hos_owner;
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.tenant_department
  FOR EACH ROW EXECUTE FUNCTION kernel.tenant_department_capture_version();
