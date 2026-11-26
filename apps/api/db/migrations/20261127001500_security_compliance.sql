-- P7 Security & Compliance services (layer L3): data-protection requests, and read access for the
-- integrity monitor (module map P7; map §1.1; tenancy specification E-34 to E-37, E-46(4) and (5)).
-- PROVISIONAL (Phase 1): the security and audit specification is not written yet. Data requests are
-- received and tracked by P7; each owning module performs its own erasure and reports back (E-34).

CREATE TABLE app.sec_data_request (
  id                 uuid        PRIMARY KEY,
  organization_id    uuid        NOT NULL REFERENCES app.tenant_organization (id),
  request_type       text        NOT NULL CHECK (request_type IN ('access', 'erasure')),
  subject_type       text        NOT NULL CHECK (subject_type IN ('user')),
  subject_id         uuid        NOT NULL,
  status             text        NOT NULL CHECK (status IN ('received', 'processing', 'completed', 'rejected')),
  required_modules   text[]      NOT NULL,
  completed_modules  text[]      NOT NULL DEFAULT '{}',
  received_at        timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  version            bigint      NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  UNIQUE (organization_id, id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX sec_data_request_subject_idx ON app.sec_data_request (organization_id, subject_type, subject_id);
CALL hos_migration.enable_tenant_rls('app.sec_data_request', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.sec_data_request TO hos_app;

CREATE TABLE app.sec_idempotency_key (
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
CREATE INDEX sec_idempotency_key_expiry_idx ON app.sec_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.sec_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.sec_idempotency_key TO hos_app;
GRANT DELETE ON app.sec_idempotency_key TO hos_worker;

-- E-46(5): the integrity monitor cross-checks version history against the hash-chained audit
-- records. Read-only, non-sensitive history columns, through a monitor policy (no tenant context).
GRANT USAGE ON SCHEMA app TO hos_monitor;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_organization_history', 'tenant_property_history', 'tenant_department_history',
                           'iam_user_history', 'iam_role_history', 'iam_role_assignment_history',
                           'cfg_organization_setting_history', 'cfg_property_setting_history'] LOOP
    EXECUTE format('CREATE POLICY monitor_read ON app.%I AS PERMISSIVE FOR SELECT TO hos_monitor USING (true)', t);
    EXECUTE format('GRANT SELECT (organization_id, entity_id, version, recorded_at) ON app.%I TO hos_monitor', t);
  END LOOP;
END $$;
