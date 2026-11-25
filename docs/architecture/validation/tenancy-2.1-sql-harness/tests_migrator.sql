-- Run while logged in as hos_migrator.
\set ON_ERROR_STOP 1
SELECT t.check('H-TIME-06 hos_migrator session time zone is UTC', current_setting('TimeZone') = 'UTC', current_setting('TimeZone'));
SELECT t.expect_error('H-MIG-10 without SET ROLE, hos_migrator cannot create a table in app', 'CREATE TABLE app.mig_probe (i int)', '42501');
SELECT t.check('H-MIG-10 hos_migrator inherits no CREATE privilege on app', NOT has_schema_privilege('app', 'CREATE'));
SELECT t.expect_error('H-HIST-13 hos_migrator cannot set session_replication_role', 'SET session_replication_role = replica', '42501');
SET ROLE hos_owner;
SELECT t.check('H-MIG-10 after SET ROLE, current_user is hos_owner', current_user = 'hos_owner', current_user);
SELECT t.expect_error('H-HIST-13 hos_owner cannot set session_replication_role', 'SET session_replication_role = replica', '42501');

-- H-MIG-16: the actual migration SET ROLE flow (C-19).
SELECT t.check('H-MIG-16 hos_owner has no membership in definer roles',
  NOT pg_has_role('hos_owner', 'hos_history_writer', 'MEMBER') AND NOT pg_has_role('hos_owner', 'hos_lookup_tenant', 'MEMBER'));
SELECT t.check('H-MIG-16 hos_migrator has SET but not USAGE (no inherited privileges) on definer roles',
  pg_has_role('hos_migrator', 'hos_history_writer', 'SET') AND NOT pg_has_role('hos_migrator', 'hos_history_writer', 'USAGE')
  AND pg_has_role('hos_migrator', 'hos_lookup_tenant', 'SET') AND NOT pg_has_role('hos_migrator', 'hos_lookup_tenant', 'USAGE'));
SET ROLE hos_history_writer;
SELECT t.check('H-MIG-16 with current role hos_owner, SET ROLE hos_history_writer succeeds (checked against session user hos_migrator)',
  current_user = 'hos_history_writer' AND session_user = 'hos_migrator', current_user || ' / ' || session_user);
SET ROLE hos_owner;

-- H-HIST-12 LIMITATION + DETECTION: the table owner can disable the guard with DDL; the catalog check sees it. Rolled back.
BEGIN;
SAVEPOINT owner_ddl;
ALTER TABLE app.tenant_department_history DISABLE TRIGGER history_guard;
SELECT count(*) AS n FROM pg_class c
 WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r' AND c.relname LIKE '%\_history'
   AND (SELECT count(*) FROM pg_trigger tg
         WHERE tg.tgrelid = c.oid AND tg.tgname IN ('history_guard', 'history_no_truncate') AND tg.tgenabled = 'O') <> 2 \gset det_
ROLLBACK TO SAVEPOINT owner_ddl;
SELECT t.check('H-HIST-12 LIMITATION: the table owner (via migration) can disable the history guard', true, 'ALTER TABLE ... DISABLE TRIGGER succeeded');
SELECT t.check('H-HIST-12 the H-MIG-13 catalog check detects the disabled guard', :det_n = 1, 'tables flagged=' || :det_n);
SELECT t.check('H-HIST-12 after rollback the guard is enabled again',
  (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'app.tenant_department_history'::regclass AND tgname = 'history_guard') = 'O');
COMMIT;
SELECT t.expect_affected('H-MIG-12 owner UPDATE on a tenant table silently affects 0 rows', 'UPDATE app.tenant_department SET name = name', 0);
SELECT t.expect_count('H-MIG-12 owner sees no tenant rows', 'SELECT 1 FROM app.tenant_department', 0);
SELECT t.expect_error('H-MIG-15 hos_owner alone cannot replace a definer function',
  $q$CREATE OR REPLACE FUNCTION kernel.organization_status(p_organization_id uuid) RETURNS text
     LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$ SELECT 'x' $f$$q$, '42501');
SET ROLE hos_lookup_tenant;
SELECT t.expect_affected('H-MIG-15 the migrator, switched to the designated owner, can replace it',
  $q$CREATE OR REPLACE FUNCTION kernel.organization_status(p_organization_id uuid) RETURNS text
     LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
       SELECT coalesce((SELECT o.status FROM app.tenant_organization AS o WHERE o.id = p_organization_id), 'not_found') $f$$q$, 0);
SET ROLE hos_owner;
SELECT t.check('H-MIG-15 after replacement the owner is still hos_lookup_tenant',
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'kernel.organization_status(uuid)'::regprocedure) = 'hos_lookup_tenant');
SELECT t.check('H-MIG-15 after replacement PUBLIC still cannot execute it',
  NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = 'kernel.organization_status(uuid)'::regprocedure AND a.grantee = 0));
RESET ROLE;
