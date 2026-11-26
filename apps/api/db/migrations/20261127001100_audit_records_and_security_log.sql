-- P7 Security & Compliance kernel (layer L1): the tenant audit store and the system security log.
-- Basis: module map §1.1 (audit data protection, hash chain over the redacted payload), §7.1 (audit
-- writer in the same transaction, verified actor, no P2 call), §7.2 (system security log: allowlisted
-- fields, INSERT-only writer that cannot read the log, append-only aggregation); tenancy specification
-- C-04 (append-only: no UPDATE or DELETE for runtime roles), E-24 (entity reference with version).
-- PROVISIONAL (Phase 1): the security and audit specification, which owns these schemas (E-25), is not
-- written yet. The hos_monitor read policies serve the scheduled integrity check (E-46(4), map §7.2).

CREATE TABLE audit.audit_record (
  id                  uuid        PRIMARY KEY,
  organization_id     uuid        NOT NULL REFERENCES app.tenant_organization (id),
  property_id         uuid,                     -- attribute only; isolation is by organization
  sequence            bigint      NOT NULL CHECK (sequence >= 1),
  recorded_at         timestamptz NOT NULL,
  module              text        NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{0,31}$'),
  action              text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{0,127}$'),
  entity_type         text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  entity_id           uuid        NOT NULL,
  entity_version      bigint,
  actor_id            uuid        NOT NULL,
  actor_realm         text        NOT NULL CHECK (actor_realm IN ('hotel_employee', 'guest', 'machine')),
  actor_kind          text        NOT NULL CHECK (actor_kind IN ('user', 'service_identity', 'support_session')),
  on_behalf_of_id     uuid,
  correlation_id      uuid        NOT NULL,
  causation_id        uuid,
  request_id          text        NOT NULL CHECK (length(request_id) BETWEEN 1 AND 64),
  entry_point         text        NOT NULL,
  changed_fields      text[]      NOT NULL,
  payload             jsonb       NOT NULL,
  previous_hash       bytea       NOT NULL CHECK (length(previous_hash) = 32),
  record_hash         bytea       NOT NULL CHECK (length(record_hash) = 32),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, sequence)
);
CREATE INDEX audit_record_entity_idx ON audit.audit_record (organization_id, entity_type, entity_id);
CREATE INDEX audit_record_time_idx   ON audit.audit_record (organization_id, recorded_at, id);
CALL hos_migration.enable_tenant_rls('audit.audit_record', 'organization');
GRANT USAGE ON SCHEMA audit TO hos_app, hos_seclog_writer, hos_monitor;
GRANT SELECT, INSERT ON audit.audit_record TO hos_app;          -- append-only (C-04)
CREATE POLICY monitor_read ON audit.audit_record AS PERMISSIVE FOR SELECT TO hos_monitor USING (true);
GRANT SELECT ON audit.audit_record TO hos_monitor;

-- One chain head per organization; the writer locks it, so each organization's chain is linear.
CREATE TABLE audit.audit_chain_head (
  organization_id  uuid        PRIMARY KEY REFERENCES app.tenant_organization (id),
  id               uuid        NOT NULL UNIQUE,
  last_sequence    bigint      NOT NULL CHECK (last_sequence >= 0),
  last_hash        bytea       NOT NULL CHECK (length(last_hash) = 32),
  updated_at       timestamptz NOT NULL,
  UNIQUE (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('audit.audit_chain_head', 'organization');
GRANT SELECT, INSERT, UPDATE ON audit.audit_chain_head TO hos_app;
CREATE POLICY monitor_read ON audit.audit_chain_head AS PERMISSIVE FOR SELECT TO hos_monitor USING (true);
GRANT SELECT ON audit.audit_chain_head TO hos_monitor;

-- System security log (map §7.2): cell-level, no tenant columns, never mixed with tenant audit.
CREATE TABLE audit.security_event (
  id                            uuid        PRIMARY KEY,
  sequence                      bigint      NOT NULL UNIQUE CHECK (sequence >= 1),
  recorded_at                   timestamptz NOT NULL,
  cell_id                       text        NOT NULL CHECK (cell_id ~ '^[a-z0-9-]{1,64}$'),
  component                     text        NOT NULL CHECK (component ~ '^[a-z0-9_-]{1,64}$'),
  route_template                text        CHECK (length(route_template) <= 300),
  http_method                   text        CHECK (http_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  record_type                   text        NOT NULL CHECK (record_type IN ('individual', 'aggregate', 'mode_change')),
  outcome                       text        NOT NULL CHECK (outcome IN
                                  ('authn_failed', 'context_missing', 'tenant_unknown', 'authz_denied', 'context_mismatch', 'fidelity_mode')),
  reason                        text        NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  request_id                    text        CHECK (length(request_id) <= 64),
  actor_id                      uuid,
  actor_realm                   text        CHECK (actor_realm IN ('hotel_employee', 'guest', 'machine')),
  tenant_status                 text        NOT NULL CHECK (tenant_status IN
                                  ('verified_not_authorized', 'unknown', 'not_provided', 'not_evaluated')),
  target_tenant_id              uuid,
  claimed_tenant_id_untrusted   uuid,
  client_correlation_untrusted  text        CHECK (client_correlation_untrusted ~ '^[A-Za-z0-9._:-]{1,128}$'),
  source_address                inet,
  first_occurrence_id           uuid,
  aggregate_count               integer     CHECK (aggregate_count >= 1),
  first_seen_at                 timestamptz,
  last_seen_at                  timestamptz,
  writer_instance               text        NOT NULL CHECK (length(writer_instance) BETWEEN 1 AND 64),
  previous_hash                 bytea       NOT NULL CHECK (length(previous_hash) = 32),
  record_hash                   bytea       NOT NULL CHECK (length(record_hash) = 32),
  -- The target tenant is recorded only when the server verified it exists (map §7.2).
  CHECK (target_tenant_id IS NULL OR tenant_status = 'verified_not_authorized'),
  CHECK ((actor_id IS NULL) = (actor_realm IS NULL)),
  CHECK ((record_type = 'aggregate') = (first_occurrence_id IS NOT NULL AND aggregate_count IS NOT NULL
                                        AND first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL))
);
REVOKE ALL ON audit.security_event FROM PUBLIC;
GRANT INSERT ON audit.security_event TO hos_seclog_writer;       -- cannot read the log (map §7.2)
GRANT SELECT ON audit.security_event TO hos_monitor;              -- integrity check only

CREATE TABLE audit.security_chain_head (
  chain_id       text        PRIMARY KEY CHECK (chain_id = 'cell'),
  id             uuid        NOT NULL UNIQUE,
  last_sequence  bigint      NOT NULL CHECK (last_sequence >= 0),
  last_hash      bytea       NOT NULL CHECK (length(last_hash) = 32),
  updated_at     timestamptz NOT NULL
);
REVOKE ALL ON audit.security_chain_head FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON audit.security_chain_head TO hos_seclog_writer;
GRANT SELECT ON audit.security_chain_head TO hos_monitor;
