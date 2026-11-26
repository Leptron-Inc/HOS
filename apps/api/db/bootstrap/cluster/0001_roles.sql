-- HOS bootstrap, cluster revision 0001: roles and memberships.
-- Source: TENANCY_AND_DATA_CONVENTIONS.md rev 2.1, validated block 01 (C-18, C-19, C-23, C-24), unchanged.
-- Run once per cell by the database administrator (RDS master user). Not a migration (C-23).
-- Applying it to an AWS environment needs founder approval (G-17, D-025).
CREATE ROLE hos_owner           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_app             NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_api             LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_worker          LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_migrator        LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_seclog_writer   LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
-- Owners of SECURITY DEFINER functions (C-19, C-21, E-20): cannot log in.
CREATE ROLE hos_lookup_tenant   NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_lookup_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_history_writer  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_history_reader  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_history_eraser  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT hos_app TO hos_api, hos_worker;
GRANT hos_owner TO hos_migrator WITH INHERIT FALSE, SET TRUE;
GRANT hos_lookup_tenant, hos_lookup_identity, hos_history_writer, hos_history_reader, hos_history_eraser
  TO hos_migrator WITH INHERIT FALSE, SET TRUE;

ALTER ROLE hos_api           SET timezone = 'UTC';
ALTER ROLE hos_worker        SET timezone = 'UTC';
ALTER ROLE hos_migrator      SET timezone = 'UTC';
ALTER ROLE hos_seclog_writer SET timezone = 'UTC';
