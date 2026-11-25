\set ON_ERROR_STOP 1
-- Test helpers (test-only schema t; not part of the specification).
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO PUBLIC;
CREATE TABLE t.results (id serial PRIMARY KEY, test text NOT NULL, ok boolean NOT NULL, detail text);
GRANT SELECT, INSERT ON t.results TO PUBLIC;
GRANT USAGE ON SEQUENCE t.results_id_seq TO PUBLIC;

CREATE FUNCTION t.check(p_test text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO t.results (test, ok, detail) VALUES (p_test, coalesce(p_ok, false), p_detail);
END $$;

CREATE FUNCTION t.expect_error(p_test text, p_sql text, p_state text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    PERFORM t.check(p_test, SQLSTATE = p_state, SQLSTATE || ': ' || SQLERRM);
    RETURN;
  END;
  PERFORM t.check(p_test, false, 'no error raised; expected ' || p_state);
END $$;

CREATE FUNCTION t.expect_count(p_test text, p_sql text, p_n bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM (' || p_sql || ') AS q' INTO v;
  EXCEPTION WHEN OTHERS THEN
    PERFORM t.check(p_test, false, SQLSTATE || ': ' || SQLERRM);
    RETURN;
  END;
  PERFORM t.check(p_test, v = p_n, format('count=%s expected=%s', v, p_n));
END $$;

CREATE FUNCTION t.expect_value(p_test text, p_sql text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    PERFORM t.check(p_test, false, SQLSTATE || ': ' || SQLERRM);
    RETURN;
  END;
  PERFORM t.check(p_test, v IS NOT DISTINCT FROM p_expected, format('value=%s expected=%s', v, p_expected));
END $$;

CREATE FUNCTION t.expect_affected(p_test text, p_sql text, p_n bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    PERFORM t.check(p_test, false, SQLSTATE || ': ' || SQLERRM);
    RETURN;
  END;
  PERFORM t.check(p_test, v = p_n, format('rows=%s expected=%s', v, p_n));
END $$;

-- Mirrors the kernel's withTenantTransaction context (C-06): transaction-local settings only.
CREATE FUNCTION t.ctx(p_org text, p_scope text, p_props text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('hos.organization_id', p_org, true),
          set_config('hos.property_scope', p_scope, true),
          set_config('hos.property_ids', p_props, true),
          set_config('hos.actor_id', '{ACT}', true),
          set_config('hos.actor_realm', 'hotel_employee', true),
          set_config('hos.correlation_id', '{COR}', true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO PUBLIC;

-- Reference data is loaded by migrations in real use (A-10); loaded directly here.
INSERT INTO app.ref_currency (code, minor_unit, is_current) VALUES
  ('USD', 2, true), ('JPY', 0, true), ('KWD', 3, true), ('CLF', 4, true);

-- Tenant fixtures, written through the runtime role with a tenant context.
SET ROLE hos_api;
BEGIN;
SELECT t.ctx('{OrgA}', 'list', '{{A1},{A2}}');
INSERT INTO app.tenant_organization (id, display_name, status, created_by, updated_by)
  VALUES ('{OrgA}', 'Org A', 'active', '{ACT}', '{ACT}');
INSERT INTO app.tenant_property (id, organization_id, display_name, status, created_by, updated_by) VALUES
  ('{A1}', '{OrgA}', 'A1', 'active', '{ACT}', '{ACT}'),
  ('{A2}', '{OrgA}', 'A2', 'active', '{ACT}', '{ACT}');
INSERT INTO app.tenant_department (id, organization_id, property_id, code, name, status, created_by, updated_by) VALUES
  ('{HK1}', '{OrgA}', '{A1}', 'HK', 'Housekeeping', 'active', '{ACT}', '{ACT}'),
  ('{MT1}', '{OrgA}', '{A1}', 'MT', 'Maintenance', 'active', '{ACT}', '{ACT}'),
  ('{HK2}', '{OrgA}', '{A2}', 'HK', 'Housekeeping', 'active', '{ACT}', '{ACT}');
UPDATE app.tenant_department SET name = 'Housekeeping v2', version = version + 1, updated_at = now(), updated_by = '{ACT}' WHERE id = '{HK1}';
UPDATE app.tenant_department SET name = 'Housekeeping v3', version = version + 1, updated_at = now(), updated_by = '{ACT}' WHERE id = '{HK1}';
INSERT INTO app.iam_user (id, organization_id, idp_issuer, idp_subject, display_name, status, created_by, updated_by)
  VALUES ('{UserA}', '{OrgA}', 'https://idp.test', 'sub-1', 'User A', 'active', '{ACT}', '{ACT}');
INSERT INTO app.hk_task (id, organization_id, property_id, department_id, status, created_by, updated_by) VALUES
  ('{TaskA1}', '{OrgA}', '{A1}', '{HK1}', 'open', '{ACT}', '{ACT}'),
  ('{TaskA2}', '{OrgA}', '{A2}', '{HK2}', 'open', '{ACT}', '{ACT}'),
  ('{TaskC}',  '{OrgA}', '{A1}', '{HK1}', 'open', '{ACT}', '{ACT}'),
  ('{TaskD}',  '{OrgA}', '{A1}', '{HK1}', 'open', '{ACT}', '{ACT}');
INSERT INTO app.crm_guest_profile (id, organization_id, full_name, id_document_number, created_by, updated_by) VALUES
  ('{Guest}',  '{OrgA}', 'Test Guest',   'X1234567', '{ACT}', '{ACT}'),
  ('{Guest2}', '{OrgA}', 'Second Guest', 'Y7654321', '{ACT}', '{ACT}');
COMMIT;

BEGIN;
SELECT t.ctx('{OrgB}', 'list', '{{B1}}');
INSERT INTO app.tenant_organization (id, display_name, status, created_by, updated_by)
  VALUES ('{OrgB}', 'Org B', 'active', '{ACT}', '{ACT}');
INSERT INTO app.tenant_property (id, organization_id, display_name, status, created_by, updated_by)
  VALUES ('{B1}', '{OrgB}', 'B1', 'active', '{ACT}', '{ACT}');
INSERT INTO app.tenant_department (id, organization_id, property_id, code, name, status, created_by, updated_by)
  VALUES ('{HKB}', '{OrgB}', '{B1}', 'HK', 'Housekeeping', 'active', '{ACT}', '{ACT}');
INSERT INTO app.iam_user (id, organization_id, idp_issuer, idp_subject, display_name, status, created_by, updated_by)
  VALUES ('{UserB}', '{OrgB}', 'https://idp.test', 'sub-1', 'User B', 'active', '{ACT}', '{ACT}');
COMMIT;
RESET ROLE;
