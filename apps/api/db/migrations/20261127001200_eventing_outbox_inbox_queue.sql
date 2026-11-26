-- P3 Event & Workflow Engine kernel (layer L1) and relay storage.
-- Basis: D-018 (transactional outbox, at-least-once delivery, idempotent consumers), map G4, §7.1
-- (outbox writer in the same transaction), tenancy specification CX-11, CX-13, H-JOB.
-- PROVISIONAL (Phase 1): the events specification (envelope, outbox/inbox schema, relay system role
-- policies, dead-letter handling) is not written yet. hos_relay has cross-tenant access only on these
-- eventing tables, through the relay_access policies (tenancy specification §3.1, last row).
-- eventing.queue_message is the LOCAL queue adapter (durable, SQS-like visibility timeout and redrive);
-- production uses AWS SQS (D-018), which needs approved AWS resources (D-025).

CREATE TABLE eventing.outbox (
  id                uuid        PRIMARY KEY,                -- the event ID
  organization_id   uuid        NOT NULL REFERENCES app.tenant_organization (id),
  property_id       uuid,                                   -- attribute; isolation is by organization
  event_type        text        NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$'),
  event_version     integer     NOT NULL CHECK (event_version >= 1),
  payload           jsonb       NOT NULL,
  occurred_at       timestamptz NOT NULL,
  correlation_id    uuid        NOT NULL,
  causation_id      uuid,
  actor_id          uuid        NOT NULL,
  actor_realm       text        NOT NULL CHECK (actor_realm IN ('hotel_employee', 'guest', 'machine')),
  actor_kind        text        NOT NULL CHECK (actor_kind IN ('user', 'service_identity', 'support_session')),
  on_behalf_of_id   uuid,
  ordering_key      text        NOT NULL CHECK (length(ordering_key) BETWEEN 1 AND 200),
  published_at      timestamptz,
  publish_attempts  integer     NOT NULL DEFAULT 0,
  UNIQUE (organization_id, id)
);
-- Relay scan of unpublished events: a system lookup index (B-13 exception, listed in the manifest).
CREATE INDEX outbox_unpublished_idx ON eventing.outbox (occurred_at, id) WHERE published_at IS NULL;
CALL hos_migration.enable_tenant_rls('eventing.outbox', 'organization');
GRANT USAGE ON SCHEMA eventing TO hos_app, hos_relay, hos_monitor;
GRANT INSERT ON eventing.outbox TO hos_app;
CREATE POLICY relay_access ON eventing.outbox AS PERMISSIVE FOR ALL TO hos_relay USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (published_at, publish_attempts) ON eventing.outbox TO hos_relay;

-- Consumer inbox: one row per (consumer, event), written in the consumer's business transaction.
CREATE TABLE eventing.inbox (
  organization_id  uuid        NOT NULL REFERENCES app.tenant_organization (id),
  consumer         text        NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  event_id         uuid        NOT NULL,
  id               uuid        NOT NULL UNIQUE,
  processed_at     timestamptz NOT NULL,
  PRIMARY KEY (organization_id, consumer, event_id)
);
CALL hos_migration.enable_tenant_rls('eventing.inbox', 'organization');
GRANT SELECT, INSERT ON eventing.inbox TO hos_app;

-- Dead letters: events that could not be processed. Readable and replayable by the tenant (audited);
-- written by the relay. No foreign key: events for an unknown tenant are dead-lettered too (H-JOB-03).
CREATE TABLE eventing.dead_letter (
  id                uuid        PRIMARY KEY,
  organization_id   uuid        NOT NULL,
  queue             text        NOT NULL CHECK (queue ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  event_id          uuid        NOT NULL,
  event_type        text        NOT NULL,
  envelope          jsonb       NOT NULL,
  reason            text        NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  receive_count     integer     NOT NULL,
  failed_at         timestamptz NOT NULL,
  status            text        NOT NULL CHECK (status IN ('dead', 'replay_requested', 'replayed')),
  replay_requested_by uuid,
  replay_requested_at timestamptz,
  replayed_at       timestamptz,
  version           bigint      NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id)
);
CREATE INDEX dead_letter_status_idx ON eventing.dead_letter (organization_id, status, failed_at);
-- Relay scan of replay requests across tenants (B-13 exception, listed in the manifest).
CREATE INDEX dead_letter_replay_idx ON eventing.dead_letter (replay_requested_at) WHERE status = 'replay_requested';
CALL hos_migration.enable_tenant_rls('eventing.dead_letter', 'organization');
GRANT SELECT, UPDATE (status, replay_requested_by, replay_requested_at, version) ON eventing.dead_letter TO hos_app;
CREATE POLICY relay_access ON eventing.dead_letter AS PERMISSIVE FOR ALL TO hos_relay USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (status, replayed_at, version) ON eventing.dead_letter TO hos_relay;

-- Local queue adapter (system scope, no tenant columns; the body is the event envelope).
CREATE TABLE eventing.queue_message (
  id                uuid        PRIMARY KEY,
  queue             text        NOT NULL CHECK (queue ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  message_group     text        NOT NULL CHECK (length(message_group) BETWEEN 1 AND 200),
  body              jsonb       NOT NULL,
  enqueued_at       timestamptz NOT NULL,
  visible_at        timestamptz NOT NULL,
  receive_count     integer     NOT NULL DEFAULT 0,
  receipt           uuid,
  last_error        text        CHECK (last_error ~ '^[a-z][a-z0-9_]{0,63}$')
);
CREATE INDEX queue_message_ready_idx ON eventing.queue_message (queue, visible_at);
REVOKE ALL ON eventing.queue_message FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON eventing.queue_message TO hos_relay;
GRANT SELECT ON eventing.queue_message TO hos_monitor;     -- queue depth monitoring (P6)
