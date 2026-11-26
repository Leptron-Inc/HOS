-- P5 Document Management (module map P5 and its protection model; tenancy specification E-17, E-26,
-- E-30, E-31, CX-13). File contents live in the storage adapter (S3 with KMS in production, which
-- needs approved AWS resources; an encrypted local adapter for development and tests), never in
-- tenant tables. Object keys are opaque and never exposed.
-- PROVISIONAL (Phase 1): the P5 specification and the security and audit specification (download
-- rules, presigned URL lifetime, retention values) are not written yet.

CREATE TABLE app.doc_document (
  id                uuid        PRIMARY KEY,
  organization_id   uuid        NOT NULL REFERENCES app.tenant_organization (id),
  scope_level       text        NOT NULL CHECK (scope_level IN ('organization', 'property')),
  property_id       uuid,
  document_class    text        NOT NULL CHECK (document_class IN ('identity', 'financial', 'contract', 'general')),
  title             text        NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  status            text        NOT NULL CHECK (status IN ('active', 'deleted')),
  current_version   integer     NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  retention_until   timestamptz,
  deleted_at        timestamptz,
  deletion_reason   text        CHECK (deletion_reason IN ('user_request', 'retention_expired')),
  version           bigint      NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  UNIQUE (organization_id, id),
  CHECK ((scope_level = 'property') = (property_id IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL AND deletion_reason IS NOT NULL)),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CREATE INDEX doc_document_property_idx ON app.doc_document (organization_id, property_id);
CREATE INDEX doc_document_search_idx   ON app.doc_document (organization_id, document_class, title, id);
-- Retention job: due documents across tenants (CX-13; B-13 exception, listed in the manifest).
CREATE INDEX doc_document_retention_idx ON app.doc_document (retention_until) WHERE status = 'active' AND retention_until IS NOT NULL;
CALL hos_migration.enable_tenant_rls('app.doc_document', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.doc_document TO hos_app;
CREATE POLICY relay_access ON app.doc_document AS PERMISSIVE FOR ALL TO hos_relay USING (true) WITH CHECK (false);
GRANT SELECT (id, organization_id, status, retention_until) ON app.doc_document TO hos_relay;

CREATE TABLE app.doc_document_history (
  organization_id uuid NOT NULL, entity_id uuid NOT NULL, version bigint NOT NULL,
  recorded_at timestamptz NOT NULL, correlation_id uuid NOT NULL, actor_id uuid NOT NULL,
  document_class text NOT NULL, title text, status text NOT NULL, current_version integer NOT NULL,
  retention_until timestamptz, deletion_reason text,
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.doc_document_history', 'organization', false, ARRAY['title']);
GRANT SELECT ON app.doc_document_history TO hos_app;
GRANT INSERT ON app.doc_document_history TO hos_history_writer;
GRANT SELECT (organization_id, entity_id, erased_at), UPDATE (title, erased_at, erasure_reason, erasure_reference)
  ON app.doc_document_history TO hos_history_eraser;
CREATE POLICY monitor_read ON app.doc_document_history AS PERMISSIVE FOR SELECT TO hos_monitor USING (true);
GRANT SELECT (organization_id, entity_id, version, recorded_at) ON app.doc_document_history TO hos_monitor;

SET ROLE hos_history_writer;          -- C-19
CREATE FUNCTION kernel.doc_document_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.doc_document_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id, document_class, title, status, current_version,
     retention_until, deletion_reason)
  VALUES
    (NEW.organization_id, NEW.id, NEW.version, now(), current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.document_class, NEW.title, NEW.status, NEW.current_version, NEW.retention_until, NEW.deletion_reason);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.doc_document_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.doc_document_capture_version() TO hos_owner;
SET ROLE hos_history_eraser;
CREATE FUNCTION kernel.doc_document_erase_history(p_entity_id uuid, p_reason text, p_reference uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  UPDATE app.doc_document_history AS h
     SET title = NULL, erased_at = now(), erasure_reason = p_reason, erasure_reference = p_reference
   WHERE h.entity_id = p_entity_id AND h.erased_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION kernel.doc_document_erase_history(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.doc_document_erase_history(uuid, text, uuid) TO hos_worker;
SET ROLE hos_owner;
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.doc_document
  FOR EACH ROW EXECUTE FUNCTION kernel.doc_document_capture_version();

-- Document versions: append-only (C-04). The storage key is opaque and never leaves the server.
CREATE TABLE app.doc_document_version (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  document_id      uuid        NOT NULL,
  version_number   integer     NOT NULL CHECK (version_number >= 1),
  storage_key      text        NOT NULL CHECK (storage_key ~ '^[A-Za-z0-9_-]{43}$'),
  content_type     text        NOT NULL CHECK (content_type ~ '^[a-z]+/[a-z0-9.+-]{1,100}$'),
  size_bytes       bigint      NOT NULL CHECK (size_bytes >= 0),
  sha256           text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, document_id, version_number),
  FOREIGN KEY (organization_id, document_id) REFERENCES app.doc_document (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('app.doc_document_version', 'organization');
GRANT SELECT, INSERT ON app.doc_document_version TO hos_app;

CREATE TABLE app.doc_idempotency_key (
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
CREATE INDEX doc_idempotency_key_expiry_idx ON app.doc_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.doc_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.doc_idempotency_key TO hos_app;
GRANT DELETE ON app.doc_idempotency_key TO hos_worker;
