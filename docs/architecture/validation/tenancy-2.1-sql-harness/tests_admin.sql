\set ON_ERROR_STOP 1
\i prepare.sql

-- ===================== H-ISO / H-PROP (as hos_api) =====================
SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_count('H-ISO-01 OrgA context sees no OrgB departments', $q$SELECT 1 FROM app.tenant_department WHERE organization_id <> '{OrgA}'$q$, 0);
SELECT t.expect_count('H-ISO-01 OrgA context sees its 3 departments', 'SELECT 1 FROM app.tenant_department', 3);
SELECT t.expect_count('H-ISO-01 OrgA context sees its 2 properties', 'SELECT 1 FROM app.tenant_property', 2);
SELECT t.expect_count('H-ISO-01 OrgA context sees only its organization row', 'SELECT 1 FROM app.tenant_organization', 1);
SELECT t.expect_error('H-ISO-02 insert for OrgB under OrgA context rejected',
  $q$INSERT INTO app.tenant_department (id, organization_id, property_id, code, name, status, created_by, updated_by)
     VALUES ('d0000000-0000-7000-8000-0000000000ff', '{OrgB}', '{B1}', 'X', 'X', 'active', '{ACT}', '{ACT}')$q$, '42501');
SELECT t.expect_affected('H-ISO-03 update of an OrgB row under OrgA context affects 0 rows',
  $q$UPDATE app.tenant_department SET name = 'x', version = version + 1 WHERE id = '{HKB}'$q$, 0);
SELECT t.expect_error('H-ISO-04 composite FK to an OrgB parent rejected',
  $q$INSERT INTO app.hk_task (id, organization_id, property_id, department_id, status, created_by, updated_by)
     VALUES ('7a5c0000-0000-7000-8000-0000000000f1', '{OrgA}', '{A1}', '{HKB}', 'open', '{ACT}', '{ACT}')$q$, '23503');
SELECT t.expect_count('H-PROP-04 organization-wide scope sees A1 and A2 departments', 'SELECT 1 FROM app.tenant_department', 3);
COMMIT;

BEGIN;
SELECT t.ctx('{OrgA}', 'list', '{{A1}}');
SELECT t.expect_count('H-PROP-02 listed scope [A1] sees only A1 departments', 'SELECT 1 FROM app.tenant_department', 2);
SELECT t.expect_count('H-PROP-03 listed scope [A1] cannot select an A2 row by ID', $q$SELECT 1 FROM app.tenant_department WHERE id = '{HK2}'$q$, 0);
SELECT t.expect_error('H-PROP-05 insert of an A2 row under scope [A1] rejected',
  $q$INSERT INTO app.hk_task (id, organization_id, property_id, department_id, status, created_by, updated_by)
     VALUES ('7a5c0000-0000-7000-8000-0000000000f2', '{OrgA}', '{A2}', '{HK2}', 'open', '{ACT}', '{ACT}')$q$, '42501');
COMMIT;
RESET ROLE;
SELECT t.expect_count('H-ISO-05 both organizations use department code HK without conflict',
  $q$SELECT 1 FROM app.tenant_department WHERE code = 'HK'$q$, 3);

-- ===================== H-FK (as hos_api) =====================
SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_error('H-FK-01 A1 note referencing an A2 task rejected (same-property FK)',
  $q$INSERT INTO app.hk_task_note (id, organization_id, property_id, task_id, body, created_by)
     VALUES ('a0e00000-0000-7000-8000-000000000001', '{OrgA}', '{A1}', '{TaskA2}', 'x', '{ACT}')$q$, '23503');
SELECT t.expect_affected('H-FK-06 A1 note referencing an A1 task accepted',
  $q$INSERT INTO app.hk_task_note (id, organization_id, property_id, task_id, body, created_by)
     VALUES ('a0e00000-0000-7000-8000-000000000002', '{OrgA}', '{A1}', '{TaskA1}', 'x', '{ACT}')$q$, 1);
SELECT t.expect_error('H-FK-02 A1 task with an A2 department rejected',
  $q$INSERT INTO app.hk_task (id, organization_id, property_id, department_id, status, created_by, updated_by)
     VALUES ('7a5c0000-0000-7000-8000-0000000000f3', '{OrgA}', '{A1}', '{HK2}', 'open', '{ACT}', '{ACT}')$q$, '23503');
SELECT t.expect_error('H-FK-03 department scope without property scope rejected (CHECK)',
  $q$INSERT INTO app.iam_role_assignment (id, organization_id, user_id, role_code, scope_property_id, scope_department_id, created_by, updated_by)
     VALUES ('a5000000-0000-7000-8000-000000000001', '{OrgA}', '{UserA}', 'hk_staff', NULL, '{HK1}', '{ACT}', '{ACT}')$q$, '23514');
SELECT t.expect_error('H-FK-04 OrgA assignment scoped to an OrgB property rejected',
  $q$INSERT INTO app.iam_role_assignment (id, organization_id, user_id, role_code, scope_property_id, scope_department_id, created_by, updated_by)
     VALUES ('a5000000-0000-7000-8000-000000000002', '{OrgA}', '{UserA}', 'hk_staff', '{B1}', NULL, '{ACT}', '{ACT}')$q$, '23503');
SELECT t.expect_error('H-DEPT-04 assignment with an A1 department under an A2 property scope rejected',
  $q$INSERT INTO app.iam_role_assignment (id, organization_id, user_id, role_code, scope_property_id, scope_department_id, created_by, updated_by)
     VALUES ('a5000000-0000-7000-8000-000000000003', '{OrgA}', '{UserA}', 'hk_staff', '{A2}', '{HK1}', '{ACT}', '{ACT}')$q$, '23503');
SELECT t.expect_affected('H-FK-06 valid department-scoped assignment accepted',
  $q$INSERT INTO app.iam_role_assignment (id, organization_id, user_id, role_code, scope_property_id, scope_department_id, created_by, updated_by)
     VALUES ('a5000000-0000-7000-8000-000000000004', '{OrgA}', '{UserA}', 'hk_staff', '{A1}', '{HK1}', '{ACT}', '{ACT}')$q$, 1);
COMMIT;
RESET ROLE;

SELECT t.expect_count('H-FK-05 every FK between tenant tables includes organization_id (and property_id property-to-property)', $q$
  SELECT c.conname FROM pg_constraint c
   WHERE c.contype = 'f' AND c.connamespace = 'app'::regnamespace
     AND c.confrelid NOT IN ('app.tenant_organization'::regclass, 'app.ref_currency'::regclass)
     AND NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
                      WHERE a.attname = 'organization_id')
  UNION ALL
  SELECT c.conname FROM pg_constraint c
   WHERE c.contype = 'f' AND c.connamespace = 'app'::regnamespace
     AND c.confrelid <> 'app.tenant_property'::regclass
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'property_id' AND NOT a.attisdropped)
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'property_id' AND NOT a.attisdropped)
     AND NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
                      WHERE a.attname = 'property_id')$q$, 0);
SELECT t.expect_count('H-DEPT-03 no policy references department_id', $q$
  SELECT 1 FROM pg_policies WHERE schemaname = 'app'
     AND (coalesce(qual, '') ~ 'department_id' OR coalesce(with_check, '') ~ 'department_id')$q$, 0);

-- ===================== H-LOOK (as hos_api, no context; and as the lookup owner role) =====================
SET ROLE hos_api;
SELECT t.expect_value('H-LOOK-01 property_status(OrgA, A1) = active', $q$SELECT kernel.property_status('{OrgA}', '{A1}')$q$, 'active');
SELECT t.expect_value('H-LOOK-01 organization_status(OrgA) = active', $q$SELECT kernel.organization_status('{OrgA}')$q$, 'active');
SELECT t.expect_value('H-LOOK-02 property of another organization = not_found', $q$SELECT kernel.property_status('{OrgB}', '{A1}')$q$, 'not_found');
SELECT t.expect_value('H-LOOK-02 unknown property = not_found', $q$SELECT kernel.property_status('{OrgA}', 'ffffffff-0000-7000-8000-000000000000')$q$, 'not_found');
SELECT t.expect_error('H-LOOK-03 direct read of tenant_property without context fails closed', 'SELECT 1 FROM app.tenant_property', '42501');
SELECT t.expect_value('H-LOOK-06 resolve_principal returns the OrgA user', $q$SELECT actor_id::text FROM kernel.resolve_principal('{OrgA}', 'https://idp.test', 'sub-1')$q$, '{UserA}');
SELECT t.expect_count('H-LOOK-06 resolve_principal is limited to the named organization', $q$SELECT 1 FROM kernel.resolve_principal('{OrgA}', 'https://idp.test', 'sub-1')$q$, 1);
SELECT t.expect_count('H-LOOK-06 list_memberships returns both organizations for the subject', $q$SELECT 1 FROM kernel.list_memberships('https://idp.test', 'sub-1')$q$, 2);
RESET ROLE;
SET ROLE hos_lookup_tenant;
SELECT t.expect_error('H-LOOK-05 lookup role cannot read display_name', 'SELECT display_name FROM app.tenant_property', '42501');
SELECT t.expect_error('H-LOOK-05 lookup role cannot insert',
  $q$INSERT INTO app.tenant_organization (id, display_name, status, created_by, updated_by) VALUES (gen_random_uuid(), 'x', 'active', '{ACT}', '{ACT}')$q$, '42501');
SELECT t.expect_count('H-LOOK-05 lookup role reads only its granted columns, across tenants', 'SELECT id, status FROM app.tenant_organization', 2);
RESET ROLE;

-- ===================== H-DEF (catalog) =====================
SELECT t.expect_count('H-DEF-01 exactly the 8 allowlisted SECURITY DEFINER functions exist', $q$
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration') AND p.prosecdef$q$, 8);
SELECT t.expect_count('H-DEF-01 definer functions: kernel schema, designated owner, fixed search_path', $q$
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration') AND p.prosecdef
     AND NOT (n.nspname = 'kernel'
              AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
              AND pg_get_userbyid(p.proowner) = CASE
                    WHEN p.proname IN ('organization_status', 'property_status') THEN 'hos_lookup_tenant'
                    WHEN p.proname IN ('resolve_principal', 'list_memberships') THEN 'hos_lookup_identity'
                    WHEN p.proname LIKE '%\_capture\_version' THEN 'hos_history_writer'
                    WHEN p.proname LIKE '%\_history\_sensitive' THEN 'hos_history_reader'
                    WHEN p.proname LIKE '%\_erase\_history' THEN 'hos_history_eraser'
                  END)$q$, 0);
SELECT t.expect_count('H-DEF-02 no HOS function or procedure is executable by PUBLIC', $q$
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration')
     AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))$q$, 0);
SELECT t.check('H-DEF-03 hos_api cannot execute the erasure function',
  NOT has_function_privilege('hos_api', 'kernel.crm_guest_profile_erase_history(uuid,text,uuid)', 'EXECUTE'));
SELECT t.check('H-DEF-03 hos_worker can execute the erasure function',
  has_function_privilege('hos_worker', 'kernel.crm_guest_profile_erase_history(uuid,text,uuid)', 'EXECUTE'));
SELECT t.check('H-DEF-03 hos_api cannot execute migration helpers',
  NOT has_function_privilege('hos_api', 'hos_migration.enable_tenant_rls(regclass,text)', 'EXECUTE'));
SELECT t.expect_count('H-DEF-04 no definer function is LEAKPROOF', $q$
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration') AND p.prosecdef AND p.proleakproof$q$, 0);
SELECT t.expect_count('H-DEF-05 no plpgsql definer function uses dynamic EXECUTE', $q$
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration') AND p.prosecdef
     AND l.lanname = 'plpgsql' AND p.prosrc ~* '\mexecute\M'$q$, 0);

-- ===================== H-MIG (catalog) =====================
SELECT t.expect_count('H-MIG-01 tenant tables without forced RLS', $q$
  SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity)$q$, 0);
SELECT t.check('H-MIG-01 tenant_organization has forced RLS',
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'app.tenant_organization'::regclass));
SELECT t.expect_count('H-MIG-02 every policy is on the C-09 allowlist', $q$
  SELECT p.tablename, p.policyname FROM pg_policies p
   WHERE p.schemaname = 'app' AND NOT (
         (p.policyname = 'tenant_isolation' AND p.roles = '{hos_app}'::name[] AND p.cmd IN ('ALL', 'SELECT'))
      OR (p.policyname = 'kernel_lookup' AND p.cmd = 'SELECT' AND p.roles <@ '{hos_lookup_tenant,hos_lookup_identity}'::name[])
      OR (p.policyname = 'history_write' AND p.cmd = 'INSERT' AND p.roles = '{hos_history_writer}'::name[])
      OR (p.policyname = 'history_read_sensitive' AND p.cmd = 'SELECT' AND p.roles = '{hos_history_reader}'::name[])
      OR (p.policyname IN ('history_erase_select', 'history_erase') AND p.cmd IN ('SELECT', 'UPDATE') AND p.roles = '{hos_history_eraser}'::name[]))$q$, 0);
SELECT t.expect_count('H-MIG-02 every tenant table has a tenant_isolation policy', $q$
  SELECT c.oid FROM pg_class c
   WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r'
     AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id') OR c.oid = 'app.tenant_organization'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')$q$, 0);
SELECT t.expect_count('H-MIG-03 no hos_ role is superuser or BYPASSRLS', $q$
  SELECT 1 FROM pg_roles WHERE rolname LIKE 'hos\_%' AND (rolsuper OR rolbypassrls)$q$, 0);
SELECT t.expect_count('H-MIG-03 login and runtime roles own no objects', $q$
  SELECT 1 FROM pg_class WHERE pg_get_userbyid(relowner) IN ('hos_app', 'hos_api', 'hos_worker', 'hos_migrator', 'hos_seclog_writer')
  UNION ALL SELECT 1 FROM pg_proc WHERE pg_get_userbyid(proowner) IN ('hos_app', 'hos_api', 'hos_worker', 'hos_migrator', 'hos_seclog_writer')
  UNION ALL SELECT 1 FROM pg_namespace WHERE pg_get_userbyid(nspowner) IN ('hos_app', 'hos_api', 'hos_worker', 'hos_migrator', 'hos_seclog_writer')$q$, 0);
SELECT t.expect_count('H-MIG-03 no PUBLIC privileges on HOS tables, schemas or the database', $q$
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration')
     AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0)
  UNION ALL
  SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration', 'public')
     AND EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = 0)
  UNION ALL
  SELECT 1 FROM pg_database d WHERE d.datname = current_database()
     AND (d.datacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(d.datacl) a WHERE a.grantee = 0))$q$, 0);
SELECT t.expect_count('H-MIG-03 no views without security_invoker, no materialized views', $q$
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration')
     AND ((c.relkind = 'v' AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)) OR c.relkind = 'm')$q$, 0);
SELECT t.expect_count('H-MIG-08 every FK (except to global_reference) has a matching leading index', $q$
  SELECT c.conname FROM pg_constraint c
   WHERE c.contype = 'f' AND c.connamespace = 'app'::regnamespace
     AND c.confrelid <> 'app.ref_currency'::regclass
     AND NOT EXISTS (SELECT 1 FROM pg_index i
                      WHERE i.indrelid = c.conrelid
                        AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] = c.conkey)$q$, 0);
SELECT t.expect_count('H-MIG-08 tenant secondary indexes lead with organization_id (except the listed lookup index)', $q$
  SELECT ic.relname FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
   WHERE tc.relnamespace = 'app'::regnamespace AND NOT i.indisprimary
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = tc.oid AND a.attname = 'organization_id')
     AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = tc.oid AND a.attnum = i.indkey[0]) <> 'organization_id'
     AND ic.relname <> 'iam_user_subject_idx'$q$, 0);
SELECT t.expect_count('H-MIG-09 hos_migrator -> hos_owner is INHERIT FALSE, SET TRUE', $q$
  SELECT 1 FROM pg_auth_members m
   WHERE m.member = 'hos_migrator'::regrole AND m.roleid = 'hos_owner'::regrole AND NOT m.inherit_option AND m.set_option$q$, 1);
SELECT t.expect_count('H-MIG-09 hos_migrator -> each definer owner role is INHERIT FALSE, SET TRUE', $q$
  SELECT 1 FROM pg_auth_members m
   WHERE m.member = 'hos_migrator'::regrole AND NOT m.inherit_option AND m.set_option
     AND pg_get_userbyid(m.roleid) IN ('hos_lookup_tenant', 'hos_lookup_identity', 'hos_history_writer', 'hos_history_reader', 'hos_history_eraser')$q$, 5);
SELECT t.expect_count('H-MIG-09 no role except hos_migrator can inherit or SET to hos_owner or a definer role', $q$
  SELECT 1 FROM pg_auth_members m
   WHERE pg_get_userbyid(m.roleid) IN ('hos_owner', 'hos_lookup_tenant', 'hos_lookup_identity', 'hos_history_writer', 'hos_history_reader', 'hos_history_eraser')
     AND m.member <> 'hos_migrator'::regrole AND (m.inherit_option OR m.set_option)$q$, 0);
SELECT t.expect_count('H-MIG-09 the only other membership rows in those roles are the bootstrap administrator''s ADMIN-only rows', $q$
  SELECT 1 FROM pg_auth_members m
   WHERE pg_get_userbyid(m.roleid) IN ('hos_owner', 'hos_lookup_tenant', 'hos_lookup_identity', 'hos_history_writer', 'hos_history_reader', 'hos_history_eraser')
     AND m.member NOT IN ('hos_migrator'::regrole, '{BOOTADMIN}'::regrole)$q$, 0);
SELECT t.expect_count('H-MIG-17 bootstrap administrator keeps no INHERIT or SET membership in any HOS role (temporary SET removed)', $q$
  SELECT 1 FROM pg_auth_members m
   WHERE m.member = '{BOOTADMIN}'::regrole AND pg_get_userbyid(m.roleid) LIKE 'hos\_%'
     AND (m.inherit_option OR m.set_option)$q$, 0);
SELECT t.check('H-MIG-17 bootstrap administrator: ' || '{BOOTADMIN}' || ', superuser=' ||
  (SELECT rolsuper::text FROM pg_roles WHERE rolname = '{BOOTADMIN}') || ', ADMIN-only rows=' ||
  (SELECT count(*)::text FROM pg_auth_members WHERE member = '{BOOTADMIN}'::regrole AND admin_option AND NOT inherit_option AND NOT set_option),
  true, 'informational');
SELECT t.expect_count('H-MIG-09 hos_migrator holds no inherited membership at all', $q$
  SELECT 1 FROM pg_auth_members m WHERE m.member = 'hos_migrator'::regrole AND m.inherit_option$q$, 0);
SELECT t.expect_count('H-MIG-09 runtime login roles are members of hos_app only', $q$
  SELECT 1 FROM pg_auth_members m
   WHERE pg_get_userbyid(m.member) IN ('hos_api', 'hos_worker', 'hos_seclog_writer') AND m.roleid <> 'hos_app'::regrole$q$, 0);
SELECT t.expect_count('H-MIG-09 owner roles cannot log in', $q$
  SELECT 1 FROM pg_roles WHERE rolcanlogin AND rolname IN ('hos_owner', 'hos_app', 'hos_lookup_tenant', 'hos_lookup_identity',
                                                            'hos_history_writer', 'hos_history_reader', 'hos_history_eraser')$q$, 0);
SELECT t.expect_count('H-MIG-11 objects in HOS schemas owned by hos_owner (definer functions by their owner role)', $q$
  SELECT c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration') AND pg_get_userbyid(c.relowner) <> 'hos_owner'
  UNION ALL
  SELECT p.oid::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration') AND NOT p.prosecdef AND pg_get_userbyid(p.proowner) <> 'hos_owner'
  UNION ALL
  SELECT n.oid::text FROM pg_namespace n
   WHERE n.nspname IN ('app', 'kernel', 'hos_ctx', 'hos_migration') AND pg_get_userbyid(n.nspowner) <> 'hos_owner'$q$, 0);
SELECT t.expect_count('H-MIG-13 every history table has enabled guard and no-truncate triggers', $q$
  SELECT c.relname FROM pg_class c
   WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r' AND c.relname LIKE '%\_history'
     AND (SELECT count(*) FROM pg_trigger tg
           WHERE tg.tgrelid = c.oid AND tg.tgname IN ('history_guard', 'history_no_truncate') AND tg.tgenabled = 'O') <> 2$q$, 0);
SELECT t.expect_count('H-MIG-13 every base table of a history table has an enabled capture_version trigger', $q$
  SELECT c.relname FROM pg_class c
   WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r' AND c.relname LIKE '%\_history'
     AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                      WHERE tg.tgrelid = to_regclass('app.' || left(c.relname, length(c.relname) - 8))
                        AND tg.tgname = 'capture_version' AND tg.tgenabled = 'O')$q$, 0);

-- ===================== H-HIST =====================
SELECT t.expect_count('H-HIST-01 three history versions for a department inserted and updated twice', $q$
  SELECT 1 FROM app.tenant_department_history WHERE entity_id = '{HK1}'
     AND actor_id = '{ACT}' AND correlation_id = '{COR}'$q$, 3);
SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_error('H-HIST-02 hos_api cannot insert history',
  $q$INSERT INTO app.tenant_department_history (organization_id, property_id, entity_id, version, recorded_at, correlation_id, actor_id, code, name, status)
     VALUES ('{OrgA}', '{A1}', '{HK1}', 99, now(), '{COR}', '{ACT}', 'HK', 'forged', 'active')$q$, '42501');
SELECT t.expect_error('H-HIST-03 hos_api cannot update history', $q$UPDATE app.tenant_department_history SET name = 'x'$q$, '42501');
SELECT t.expect_error('H-HIST-03 hos_api cannot delete history', 'DELETE FROM app.tenant_department_history', '42501');
SELECT t.expect_error('H-HIST-04 update without a version increment fails',
  $q$UPDATE app.tenant_department SET name = 'no version bump' WHERE id = '{MT1}'$q$, '23505');
SELECT t.expect_error('H-HIST-05 hos_api cannot select the sensitive history column',
  'SELECT id_document_number FROM app.crm_guest_profile_history', '42501');
SELECT t.expect_count('H-HIST-05 hos_api can select non-sensitive history columns',
  'SELECT entity_id, version, full_name FROM app.crm_guest_profile_history', 2);
SELECT t.expect_value('H-HIST-06 sensitive read in own tenant returns the value',
  $q$SELECT id_document_number FROM kernel.crm_guest_profile_history_sensitive('{Guest}', 1)$q$, 'X1234567');
SELECT t.expect_error('H-HIST-07 hos_api cannot execute the erasure function',
  $q$SELECT kernel.crm_guest_profile_erase_history('{Guest}', 'data_subject_request', '{REF}')$q$, '42501');
COMMIT;
BEGIN;
SELECT t.ctx('{OrgB}', 'all', '{}');
SELECT t.expect_count('H-HIST-06 sensitive read from another tenant returns nothing',
  $q$SELECT 1 FROM kernel.crm_guest_profile_history_sensitive('{Guest}', 1)$q$, 0);
COMMIT;
RESET ROLE;

SET ROLE hos_history_writer;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_error('H-HIST-09 history writer cannot insert a row for another tenant',
  $q$INSERT INTO app.tenant_department_history (organization_id, property_id, entity_id, version, recorded_at, correlation_id, actor_id, code, name, status)
     VALUES ('{OrgB}', '{B1}', '{HKB}', 99, now(), '{COR}', '{ACT}', 'HK', 'forged', 'active')$q$, '42501');
COMMIT;
RESET ROLE;

SET ROLE hos_worker;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_value('H-HIST-07 hos_worker erases the guest history (1 version)',
  $q$SELECT kernel.crm_guest_profile_erase_history('{Guest}', 'data_subject_request', '{REF}')::text$q$, '1');
SELECT t.expect_value('H-HIST-07 a second erasure changes nothing',
  $q$SELECT kernel.crm_guest_profile_erase_history('{Guest}', 'data_subject_request', '{REF}')::text$q$, '0');
COMMIT;
RESET ROLE;

SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_count('H-HIST-10 erased version shows NULL values and a tombstone', $q$
  SELECT 1 FROM app.crm_guest_profile_history
   WHERE entity_id = '{Guest}' AND full_name IS NULL AND erased_at IS NOT NULL
     AND erasure_reason = 'data_subject_request' AND erasure_reference = '{REF}'$q$, 1);
SELECT t.expect_value('H-HIST-10 sensitive read of an erased version returns NULL and the reason',
  $q$SELECT coalesce(id_document_number, '<null>') || '/' || erasure_reason FROM kernel.crm_guest_profile_history_sensitive('{Guest}', 1)$q$,
  '<null>/data_subject_request');
COMMIT;
RESET ROLE;

-- Guard (E-44): the superuser session is used ONLY to bypass RLS and grants so the DML reaches the trigger.
-- This does not test protection against superusers (see H-HIST-11).
BEGIN;
SELECT t.expect_error('H-HIST-08 guard rejects changing a history value (direct DML)',
  $q$UPDATE app.tenant_department_history SET name = 'tampered' WHERE entity_id = '{HK1}'$q$, '42501');
SELECT t.expect_error('H-HIST-08 guard rejects an erasure that keeps an erasable value',
  $q$UPDATE app.crm_guest_profile_history SET erased_at = now(), erasure_reason = 'legal_order',
       erasure_reference = '{REF}', id_document_number = NULL WHERE entity_id = '{Guest2}'$q$, '42501');
SELECT t.expect_error('H-HIST-08 guard rejects changing a non-erasable column during erasure',
  $q$UPDATE app.crm_guest_profile_history SET erased_at = now(), erasure_reason = 'legal_order', erasure_reference = '{REF}',
       full_name = NULL, id_document_number = NULL, actor_id = '{UserA}' WHERE entity_id = '{Guest2}'$q$, '42501');
SELECT t.expect_error('H-HIST-08 guard rejects re-erasing an erased version',
  $q$UPDATE app.crm_guest_profile_history SET erased_at = now(), erasure_reason = 'legal_order', erasure_reference = '{REF}'
      WHERE entity_id = '{Guest}'$q$, '42501');
SELECT t.expect_error('H-HIST-08 guard rejects DELETE (direct DML)', 'DELETE FROM app.tenant_department_history', '42501');
SELECT t.expect_error('H-HIST-08 guard rejects TRUNCATE (direct DML)', 'TRUNCATE app.tenant_department_history', '42501');
COMMIT;

-- H-HIST-11 LIMITATION: a superuser can skip ordinary triggers. The change is rolled back.
BEGIN;
SAVEPOINT bypass;
SET LOCAL session_replication_role = replica;
WITH u AS (UPDATE app.tenant_department_history SET name = 'tampered' WHERE entity_id = '{HK1}' AND version = 1 RETURNING 1)
SELECT count(*) AS n FROM u \gset bypass_
ROLLBACK TO SAVEPOINT bypass;
SELECT t.check('H-HIST-11 LIMITATION: superuser with session_replication_role=replica changes history; guard does not fire',
  :bypass_n = 1, 'rows changed while bypassed=' || :bypass_n);
SELECT t.expect_count('H-HIST-11 the bypass test was rolled back (history value unchanged)',
  $q$SELECT 1 FROM app.tenant_department_history WHERE entity_id = '{HK1}' AND version = 1 AND name = 'Housekeeping'$q$, 1);
COMMIT;

-- ===================== H-IDEM (sequential; as hos_api / hos_worker) =====================
SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-1', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT t.check('H-IDEM-01 new key acquired (one row)', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
EXECUTE idem_complete('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-1', 201, '{"Location": "/v1/tasks/1"}', '{"id": "1"}');
SELECT t.check('H-IDEM-02 response stored', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
COMMIT;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-1', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT t.check('H-IDEM-02 unexpired key not re-acquired (no row)', :ROW_COUNT = 0, 'rows=' || :ROW_COUNT);
EXECUTE idem_lookup('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-1') \gset lk_
SELECT t.check('H-IDEM-02 lookup returns the stored response for replay',
  :'lk_response_status' = '201' AND :'lk_response_body'::jsonb = '{"id": "1"}'::jsonb
  AND :'lk_request_fingerprint'::bytea = decode(repeat('ab', 32), 'hex'),
  :'lk_response_status');
COMMIT;
RESET ROLE;
UPDATE app.hk_idempotency_key SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
 WHERE idempotency_key = 'key-1';
SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_lookup('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-1');
SELECT t.check('H-IDEM-03 expired record is not returned by lookup', :ROW_COUNT = 0, 'rows=' || :ROW_COUNT);
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-1', decode(repeat('cd', 32), 'hex'), '24 hours');
SELECT t.check('H-IDEM-03 expired record is replaced (one row)', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
COMMIT;
BEGIN;
SELECT t.ctx('{OrgB}', 'all', '{}');
EXECUTE idem_acquire('{OrgB}', '{ACT}', 'POST /v1/tasks', 'key-1', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT t.check('H-IDEM-08 same key in OrgB is independent (one row)', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
COMMIT;
RESET ROLE;
UPDATE app.hk_idempotency_key SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
 WHERE idempotency_key = 'key-1';
SET ROLE hos_worker;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_purge('{OrgA}', 100);
SELECT t.check('H-IDEM-07 purge deletes the expired OrgA record', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
COMMIT;
RESET ROLE;
SELECT t.expect_count('H-IDEM-07 expired OrgB record untouched by an OrgA purge',
  $q$SELECT 1 FROM app.hk_idempotency_key WHERE organization_id = '{OrgB}'$q$, 1);
SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgB}', 'all', '{}');
SELECT t.expect_error('H-IDEM-07 hos_api cannot delete idempotency records', 'DELETE FROM app.hk_idempotency_key', '42501');
COMMIT;

-- ===================== H-DEPT-06 / H-DEPT-07 (sequential) =====================
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE task_reassign('{TaskD}', '{OrgA}', '{HK1}', '{MT1}', 1, '{ACT}');
SELECT t.check('H-DEPT-06 reassignment committed first (one row)', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
COMMIT;
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE task_complete('{TaskD}', '{OrgA}', '{HK1}', 1, '{ACT}');
SELECT t.check('H-DEPT-06 completion with the old department and version affects 0 rows', :ROW_COUNT = 0, 'rows=' || :ROW_COUNT);
SELECT t.expect_error('H-DEPT-07 reassignment to another property''s department rejected',
  $q$UPDATE app.hk_task SET department_id = '{HK2}', version = version + 1 WHERE id = '{TaskA1}' AND department_id = '{HK1}' AND version = 1$q$, '23503');
COMMIT;

-- ===================== H-FIN / H-TIME (as hos_api) =====================
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SELECT t.expect_error('H-FIN-08 USD 1.234 rejected (CHECK)', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', 1.234, 'USD', 2, '2026-11-26', 'Asia/Kolkata', '{CFG}', '2025b', '{ACT}')$q$, '23514');
SELECT t.expect_error('H-FIN-08 JPY 100.5 rejected (CHECK)', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', 100.5, 'JPY', 0, '2026-11-26', 'Asia/Kolkata', '{CFG}', '2025b', '{ACT}')$q$, '23514');
SELECT t.expect_affected('H-FIN-08 KWD 1.234 accepted', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', 1.234, 'KWD', 3, '2026-11-26', 'Asia/Kolkata', '{CFG}', '2025b', '{ACT}')$q$, 1);
SELECT t.expect_error('H-FIN-08 USD with minor unit 3 rejected (FK)', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', 1.23, 'USD', 3, '2026-11-26', 'Asia/Kolkata', '{CFG}', '2025b', '{ACT}')$q$, '23503');
SELECT t.expect_error('H-FIN-09 amount with 35 integer digits rejected, not truncated', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', ('1' || repeat('0', 34))::numeric, 'USD', 2, '2026-11-26', 'Asia/Kolkata', '{CFG}', '2025b', '{ACT}')$q$, '22003');
SELECT t.expect_affected('H-FIN-10 largest numeric(38,4) CLF amount accepted', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES ('f1000000-0000-7000-8000-000000000001', '{OrgA}', '{A1}', (repeat('9', 34) || '.9999')::numeric, 'CLF', 4, '2026-11-26', 'Asia/Kolkata', '{CFG}', '2025b', '{ACT}')$q$, 1);
SELECT t.expect_value('H-FIN-10 largest amount reads back exactly',
  $q$SELECT amount::text FROM app.fol_posting WHERE id = 'f1000000-0000-7000-8000-000000000001'$q$, repeat('9', 34) || '.9999');
SELECT t.expect_error('H-FIN-13 postings are append-only for hos_api', 'UPDATE app.fol_posting SET amount = amount', '42501');
SELECT t.expect_error('H-TIME-07 posting without its time zone rejected', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', 1.00, 'USD', 2, '2026-11-26', NULL, '{CFG}', '2025b', '{ACT}')$q$, '23502');
SELECT t.expect_error('H-TIME-07 posting without its configuration version rejected', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', 1.00, 'USD', 2, '2026-11-26', 'Asia/Kolkata', NULL, '2025b', '{ACT}')$q$, '23502');
SELECT t.expect_error('H-TIME-07 posting without its tzdb version rejected', $q$
  INSERT INTO app.fol_posting (id, organization_id, property_id, amount, currency, currency_minor_unit, posting_date, posting_date_time_zone, posting_config_version_id, tzdb_version, created_by)
  VALUES (gen_random_uuid(), '{OrgA}', '{A1}', 1.00, 'USD', 2, '2026-11-26', 'Asia/Kolkata', '{CFG}', NULL, '{ACT}')$q$, '23502');
SELECT t.expect_error('H-TIME-08 stored provenance cannot be updated by hos_api',
  $q$UPDATE app.fol_posting SET posting_date_time_zone = 'UTC'$q$, '42501');
SELECT t.expect_value('H-TIME-01 20:00Z on 2026-11-26 is 2026-11-27 in Asia/Kolkata',
  $q$SELECT ((timestamptz '2026-11-26T20:00:00Z') AT TIME ZONE 'Asia/Kolkata')::date::text$q$, '2026-11-27');
SELECT t.expect_value('H-TIME-01 the same instant is 2026-11-26 in America/New_York',
  $q$SELECT ((timestamptz '2026-11-26T20:00:00Z') AT TIME ZONE 'America/New_York')::date::text$q$, '2026-11-26');
SELECT t.expect_value('H-TIME-05 +14:00 zone (Pacific/Kiritimati)',
  $q$SELECT ((timestamptz '2026-11-26T20:00:00Z') AT TIME ZONE 'Pacific/Kiritimati')::date::text$q$, '2026-11-27');
SELECT t.expect_value('H-TIME-05 -11:00 zone (Pacific/Pago_Pago)',
  $q$SELECT ((timestamptz '2026-11-26T05:00:00Z') AT TIME ZONE 'Pacific/Pago_Pago')::date::text$q$, '2026-11-25');
COMMIT;
RESET ROLE;
SELECT t.expect_error('H-FIN-14 a second current row for one currency code rejected',
  $q$INSERT INTO app.ref_currency (code, minor_unit, is_current) VALUES ('USD', 3, true)$q$, '23505');
