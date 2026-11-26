-- HOS bootstrap, cluster revision 0002: system roles for P3, P4 and integrity monitoring.
-- PROVISIONAL (Phase 1 implementation): the tenancy specification (§3.1) leaves the relay, inbox
-- and scheduler system roles to the events specification, the P4 lookup owner role to P4, and the
-- monitoring identity of E-46(4) to the security and audit specification. None of those
-- specifications is written yet; these roles follow the same restrictions as block 01 and are
-- recorded as provisional in CURRENT_STATE.md.
--
-- hos_relay:              P3 outbox relay, local queue adapter and scheduler due-listing. Cross-tenant
--                         access only on its own eventing tables (policies in the eventing migration).
-- hos_monitor:            E-46(4) scheduled catalog and hash-chain integrity checks. Read-only.
-- hos_lookup_integration: owns the P4 webhook endpoint lookup (C-21 pattern; cannot log in).
CREATE ROLE hos_relay              LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_monitor            LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_lookup_integration NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT hos_lookup_integration TO hos_migrator WITH INHERIT FALSE, SET TRUE;

ALTER ROLE hos_relay   SET timezone = 'UTC';
ALTER ROLE hos_monitor SET timezone = 'UTC';
