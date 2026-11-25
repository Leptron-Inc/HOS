-- Run while logged in as hos_api (a real login session, so SET ROLE is checked against hos_api).
\set ON_ERROR_STOP 1
SELECT t.check('H-TIME-06 hos_api session time zone is UTC', current_setting('TimeZone') = 'UTC', current_setting('TimeZone'));
SELECT t.check('H-LOOK-04 session_user is hos_api', session_user = 'hos_api', session_user);

SELECT t.expect_error('H-LOOK-04 hos_api cannot SET ROLE hos_lookup_tenant', 'SET ROLE hos_lookup_tenant', '42501');
SELECT t.expect_error('H-LOOK-04 hos_api cannot SET ROLE hos_history_eraser', 'SET ROLE hos_history_eraser', '42501');
SELECT t.expect_error('H-LOOK-04 hos_api cannot SET ROLE hos_owner', 'SET ROLE hos_owner', '42501');
SELECT t.expect_error('H-MIG-14 the migration preamble fails for hos_api (SET ROLE hos_owner refused)', 'SET ROLE hos_owner', '42501');
SELECT t.expect_error('H-LOOK-07 hos_api cannot create a temporary table', 'CREATE TEMP TABLE probe (i int)', '42501');
SELECT t.expect_error('H-LOOK-07 hos_api cannot create a table in app', 'CREATE TABLE app.probe (i int)', '42501');
SELECT t.expect_error('H-LOOK-07 hos_api cannot create a function in kernel',
  $q$CREATE FUNCTION kernel.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'$q$, '42501');
SELECT t.expect_error('H-LOOK-07 hos_api cannot create anything in public', 'CREATE TABLE public.probe (i int)', '42501');
SELECT t.expect_error('H-HIST-13 hos_api cannot set session_replication_role', 'SET session_replication_role = replica', '42501');
SELECT t.expect_error('H-HIST-13 hos_api cannot disable the history guard',
  'ALTER TABLE app.tenant_department_history DISABLE TRIGGER history_guard', '42501');
SELECT t.expect_error('H-HIST-13 hos_api cannot drop the history guard',
  'DROP TRIGGER history_guard ON app.tenant_department_history', '42501');
SELECT t.expect_error('H-DEF-03 hos_api cannot call the migration helper',
  $q$CALL hos_migration.enable_tenant_rls('app.hk_task', 'property')$q$, '42501');

-- H-CTX-01 / H-POOL-01: no context, then a committed context, on one connection.
SELECT t.expect_error('H-CTX-01 tenant query with no context fails closed (42501)', 'SELECT 1 FROM app.tenant_department', '42501');
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_count('H-POOL-01 inside the transaction OrgA rows are visible', 'SELECT 1 FROM app.tenant_property', 2);
COMMIT;
SELECT t.check('H-POOL-01 context setting is empty after COMMIT',
  current_setting('hos.organization_id', true) = '', coalesce(current_setting('hos.organization_id', true), '<null>'));
SELECT t.expect_error('H-POOL-01 the next query on the same connection fails closed', 'SELECT 1 FROM app.tenant_property', '42501');
SELECT set_config('hos.organization_id', '{OrgA}', true);
SELECT t.expect_error('H-POOL-01 a transaction-local setting outside an explicit transaction does not persist',
  'SELECT 1 FROM app.tenant_property', '42501');

-- H-POOL-02: a failed transaction leaves nothing behind.
\set ON_ERROR_STOP 0
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT 1 / 0;
ROLLBACK;
\set ON_ERROR_STOP 1
BEGIN;
SELECT t.ctx('{OrgB}', 'list', '{{B1}}');
SELECT t.expect_count('H-POOL-02 after a failed OrgA transaction, an OrgB transaction sees only OrgB',
  $q$SELECT 1 FROM app.tenant_property WHERE organization_id <> '{OrgB}'$q$, 0);
SELECT t.expect_count('H-POOL-02 OrgB sees its own property', 'SELECT 1 FROM app.tenant_property', 1);
COMMIT;
