-- HOS bootstrap, database revision 0001: database privileges and schemas.
-- Source: TENANCY_AND_DATA_CONVENTIONS.md rev 2.1, validated block 02 (C-20, C-23). The only change:
-- the block names the cell database "hos"; here the statements that need the database name use
-- current_database(), so the same revision applies to any cell database name (and to test databases).
-- Run once per cell database by the database administrator, as a single transaction, so the
-- temporary membership below can never be left behind (C-23).
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hos_api, hos_worker, hos_migrator, hos_seclog_writer',
                 current_database());
END $$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- A non-superuser administrator (the RDS master user) must be able to SET ROLE hos_owner to create
-- schemas owned by it. Grant that for these statements only, then remove it.
GRANT hos_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
CREATE SCHEMA app           AUTHORIZATION hos_owner;
CREATE SCHEMA hos_ctx       AUTHORIZATION hos_owner;
CREATE SCHEMA kernel        AUTHORIZATION hos_owner;
CREATE SCHEMA hos_migration AUTHORIZATION hos_owner;
REVOKE hos_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
