-- P2 Identity & Access Management: principals, roles, role assignments, service identity keys,
-- invitations, version history, idempotency store and the P2 pre-tenant lookups.
-- Basis: tenancy specification rev 2.1 validated block 08 (iam_user columns, kernel_lookup policy,
-- column grants and the two lookup functions are kept exactly), B-09, B-10, B-25, C-21, E-20.
-- PROVISIONAL (Phase 1): the identity and authorization specification, which will define the real
-- P2 tables (spec §9), is not written yet. Additions beyond block 08 are recorded in CURRENT_STATE.md:
--   * iam_user also holds service identities (realm 'machine', kind 'service_identity'), so the
--     allowlisted kernel.resolve_principal resolves every principal and no new definer function is
--     needed (C-12);
--   * roles carry their permission codes; assignments reference roles (block 08 used role_code);
--   * sessions_valid_after revokes sessions (tokens issued earlier are refused);
--   * service identities authenticate like every principal: a token from a configured trusted issuer
--     (OAuth client credentials), mapped to an iam_user row; HOS stores no key or secret (E-26).

CREATE TABLE app.iam_user (
  id                    uuid        PRIMARY KEY,
  organization_id       uuid        NOT NULL REFERENCES app.tenant_organization (id),
  idp_issuer            text        NOT NULL,
  idp_subject           text        NOT NULL,
  display_name          text        NOT NULL,
  status                text        NOT NULL CHECK (status IN ('active', 'inactive')),
  realm                 text        NOT NULL CHECK (realm IN ('hotel_employee', 'guest', 'machine')),
  kind                  text        NOT NULL CHECK (kind IN ('user', 'service_identity')),
  sessions_valid_after  timestamptz NOT NULL DEFAULT '-infinity',
  version               bigint      NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idp_issuer, idp_subject),
  CHECK ((kind = 'service_identity') = (realm = 'machine')),
  CHECK (length(display_name) BETWEEN 1 AND 200),
  CHECK (length(idp_issuer) BETWEEN 1 AND 500 AND length(idp_subject) BETWEEN 1 AND 500)
);
-- Serves kernel.list_memberships only: the listed B-13 exception (block 08).
CREATE INDEX iam_user_subject_idx ON app.iam_user (idp_issuer, idp_subject);
CALL hos_migration.enable_tenant_rls('app.iam_user', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.iam_user TO hos_app;
GRANT SELECT (id, organization_id, idp_issuer, idp_subject, status) ON app.iam_user TO hos_lookup_identity;
CREATE POLICY kernel_lookup ON app.iam_user AS PERMISSIVE FOR SELECT TO hos_lookup_identity USING (true);

CREATE TABLE app.iam_role (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL REFERENCES app.tenant_organization (id),
  code             text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  permissions      text[]      NOT NULL,
  is_system        boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code),
  CHECK (cardinality(permissions) <= 500)
);
CALL hos_migration.enable_tenant_rls('app.iam_role', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.iam_role TO hos_app;

CREATE TABLE app.iam_role_assignment (
  id                   uuid        PRIMARY KEY,
  organization_id      uuid        NOT NULL,
  user_id              uuid        NOT NULL,
  role_id              uuid        NOT NULL,
  scope_property_id    uuid,
  scope_department_id  uuid,
  status               text        NOT NULL CHECK (status IN ('active', 'revoked')),
  version              bigint      NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NOT NULL,
  UNIQUE (organization_id, id),
  CONSTRAINT department_scope_needs_property
    CHECK (scope_department_id IS NULL OR scope_property_id IS NOT NULL),       -- B-25
  FOREIGN KEY (organization_id, user_id) REFERENCES app.iam_user (organization_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES app.iam_role (organization_id, id),
  FOREIGN KEY (organization_id, scope_property_id) REFERENCES app.tenant_property (organization_id, id),
  FOREIGN KEY (organization_id, scope_property_id, scope_department_id)
    REFERENCES app.tenant_department (organization_id, property_id, id)
);
CREATE INDEX iam_role_assignment_user_idx  ON app.iam_role_assignment (organization_id, user_id);
CREATE INDEX iam_role_assignment_role_idx  ON app.iam_role_assignment (organization_id, role_id);
CREATE INDEX iam_role_assignment_scope_idx ON app.iam_role_assignment (organization_id, scope_property_id, scope_department_id);
CALL hos_migration.enable_tenant_rls('app.iam_role_assignment', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.iam_role_assignment TO hos_app;

-- Single-use, expiring invitations (map §7.1 first administrator; P2 user lifecycle). Only a
-- SHA-256 digest of the 256-bit invitation token is stored.
CREATE TABLE app.iam_invitation (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  token_digest     bytea       NOT NULL CHECK (length(token_digest) = 32),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  status           text        NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, token_digest),
  FOREIGN KEY (organization_id, user_id) REFERENCES app.iam_user (organization_id, id),
  CHECK (expires_at > created_at)
);
CREATE INDEX iam_invitation_user_idx ON app.iam_invitation (organization_id, user_id);
CALL hos_migration.enable_tenant_rls('app.iam_invitation', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.iam_invitation TO hos_app;

-- Version history (map §1.1, E-20, E-21) for the audited P2 entities.
CREATE TABLE app.iam_user_history (
  organization_id uuid NOT NULL, entity_id uuid NOT NULL, version bigint NOT NULL,
  recorded_at timestamptz NOT NULL, correlation_id uuid NOT NULL, actor_id uuid NOT NULL,
  display_name text, status text NOT NULL, realm text NOT NULL, kind text NOT NULL,
  sessions_valid_after timestamptz NOT NULL,
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.iam_user_history', 'organization', false, ARRAY['display_name']);
GRANT SELECT ON app.iam_user_history TO hos_app;
GRANT INSERT ON app.iam_user_history TO hos_history_writer;
GRANT SELECT (organization_id, entity_id, erased_at),
      UPDATE (display_name, erased_at, erasure_reason, erasure_reference)
  ON app.iam_user_history TO hos_history_eraser;

CREATE TABLE app.iam_role_history (
  organization_id uuid NOT NULL, entity_id uuid NOT NULL, version bigint NOT NULL,
  recorded_at timestamptz NOT NULL, correlation_id uuid NOT NULL, actor_id uuid NOT NULL,
  code text NOT NULL, name text NOT NULL, permissions text[] NOT NULL, status text NOT NULL,
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.iam_role_history', 'organization', false, '{}');
GRANT SELECT ON app.iam_role_history TO hos_app;
GRANT INSERT ON app.iam_role_history TO hos_history_writer;

CREATE TABLE app.iam_role_assignment_history (
  organization_id uuid NOT NULL, entity_id uuid NOT NULL, version bigint NOT NULL,
  recorded_at timestamptz NOT NULL, correlation_id uuid NOT NULL, actor_id uuid NOT NULL,
  user_id uuid NOT NULL, role_id uuid NOT NULL, scope_property_id uuid, scope_department_id uuid,
  status text NOT NULL,
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.iam_role_assignment_history', 'organization', false, '{}');
GRANT SELECT ON app.iam_role_assignment_history TO hos_app;
GRANT INSERT ON app.iam_role_assignment_history TO hos_history_writer;

SET ROLE hos_history_writer;          -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.iam_user_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.iam_user_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id,
     display_name, status, realm, kind, sessions_valid_after)
  VALUES
    (NEW.organization_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.display_name, NEW.status, NEW.realm, NEW.kind, NEW.sessions_valid_after);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.iam_user_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.iam_user_capture_version() TO hos_owner;

CREATE FUNCTION kernel.iam_role_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.iam_role_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id, code, name, permissions, status)
  VALUES
    (NEW.organization_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.code, NEW.name, NEW.permissions, NEW.status);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.iam_role_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.iam_role_capture_version() TO hos_owner;

CREATE FUNCTION kernel.iam_role_assignment_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.iam_role_assignment_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id,
     user_id, role_id, scope_property_id, scope_department_id, status)
  VALUES
    (NEW.organization_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.user_id, NEW.role_id, NEW.scope_property_id, NEW.scope_department_id, NEW.status);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.iam_role_assignment_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.iam_role_assignment_capture_version() TO hos_owner;
SET ROLE hos_history_eraser;
CREATE FUNCTION kernel.iam_user_erase_history(p_entity_id uuid, p_reason text, p_reference uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  UPDATE app.iam_user_history AS h
     SET display_name = NULL, erased_at = now(), erasure_reason = p_reason, erasure_reference = p_reference
   WHERE h.entity_id = p_entity_id AND h.erased_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION kernel.iam_user_erase_history(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.iam_user_erase_history(uuid, text, uuid) TO hos_worker;
SET ROLE hos_owner;

CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.iam_user
  FOR EACH ROW EXECUTE FUNCTION kernel.iam_user_capture_version();
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.iam_role
  FOR EACH ROW EXECUTE FUNCTION kernel.iam_role_capture_version();
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.iam_role_assignment
  FOR EACH ROW EXECUTE FUNCTION kernel.iam_role_assignment_capture_version();

CREATE TABLE app.iam_idempotency_key (
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
CREATE INDEX iam_idempotency_key_expiry_idx ON app.iam_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.iam_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.iam_idempotency_key TO hos_app;
GRANT DELETE ON app.iam_idempotency_key TO hos_worker;

-- P2 pre-tenant lookups: validated block 08, unchanged.
SET ROLE hos_lookup_identity;         -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.resolve_principal(p_organization_id uuid, p_issuer text, p_subject text)
RETURNS TABLE (actor_id uuid, actor_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.status
    FROM app.iam_user AS u
   WHERE u.organization_id = p_organization_id AND u.idp_issuer = p_issuer AND u.idp_subject = p_subject
$$;
REVOKE ALL ON FUNCTION kernel.resolve_principal(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.resolve_principal(uuid, text, text) TO hos_app;

CREATE FUNCTION kernel.list_memberships(p_issuer text, p_subject text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.organization_id
    FROM app.iam_user AS u
   WHERE u.idp_issuer = p_issuer AND u.idp_subject = p_subject AND u.status = 'active'
$$;
REVOKE ALL ON FUNCTION kernel.list_memberships(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.list_memberships(text, text) TO hos_app;
SET ROLE hos_owner;
