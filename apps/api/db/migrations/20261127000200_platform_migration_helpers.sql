-- Platform (P1 kernel, L0): migration helpers and the history guard (E-44).
-- Source: tenancy specification rev 2.1, validated block 04, unchanged.
-- [validated 04 migration: migration helpers and the history guard]
CREATE FUNCTION hos_migration.tenant_predicate(p_scope text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_scope
    WHEN 'organization' THEN
      'organization_id = (SELECT hos_ctx.org_id())'
    WHEN 'property' THEN
      'organization_id = (SELECT hos_ctx.org_id()) AND ((SELECT hos_ctx.all_properties())'
      || ' OR property_id = ANY ((SELECT hos_ctx.property_ids())::uuid[]))'
  END
$$;

CREATE PROCEDURE hos_migration.enable_tenant_rls(p_table regclass, p_scope text)
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_pred text := hos_migration.tenant_predicate(p_scope);
BEGIN
  IF v_pred IS NULL THEN RAISE EXCEPTION 'unknown scope class %', p_scope; END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO hos_app '
                 'USING (%s) WITH CHECK (%s)', p_table, v_pred, v_pred);
END $$;

CREATE PROCEDURE hos_migration.enable_history_rls(
  p_table regclass, p_scope text, p_sensitive boolean, p_erasable text[])
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_pred text := hos_migration.tenant_predicate(p_scope);
  v_args text := coalesce((SELECT string_agg(quote_literal(c), ', ') FROM unnest(p_erasable) AS c), '');
BEGIN
  IF v_pred IS NULL THEN RAISE EXCEPTION 'unknown scope class %', p_scope; END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR SELECT TO hos_app '
                 'USING (%s)', p_table, v_pred);
  EXECUTE format('CREATE POLICY history_write ON %s AS PERMISSIVE FOR INSERT TO hos_history_writer '
                 'WITH CHECK (%s)', p_table, v_pred);
  IF p_sensitive THEN
    EXECUTE format('CREATE POLICY history_read_sensitive ON %s AS PERMISSIVE FOR SELECT '
                   'TO hos_history_reader USING (%s)', p_table, v_pred);
  END IF;
  IF cardinality(p_erasable) > 0 THEN
    EXECUTE format('CREATE POLICY history_erase_select ON %s AS PERMISSIVE FOR SELECT '
                   'TO hos_history_eraser USING (%s)', p_table, v_pred);
    EXECUTE format('CREATE POLICY history_erase ON %s AS PERMISSIVE FOR UPDATE '
                   'TO hos_history_eraser USING (%s) WITH CHECK (%s)', p_table, v_pred, v_pred);
  END IF;
  EXECUTE format('CREATE TRIGGER history_guard BEFORE UPDATE OR DELETE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION kernel.history_guard(%s)', p_table, v_args);
  EXECUTE format('CREATE TRIGGER history_no_truncate BEFORE TRUNCATE ON %s '
                 'FOR EACH STATEMENT EXECUTE FUNCTION kernel.history_guard()', p_table);
END $$;

-- E-44: the only change a history row accepts is one erasure that clears the erasable columns.
CREATE FUNCTION kernel.history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_erasable text[] := coalesce(TG_ARGV, '{}');
  v_tombstone text[] := ARRAY['erased_at', 'erasure_reason', 'erasure_reference'];
  v_column text;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'history rows cannot be deleted or truncated (%)', TG_OP USING ERRCODE = '42501';
  END IF;
  IF OLD.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'history version is already erased' USING ERRCODE = '42501';
  END IF;
  IF NEW.erased_at IS NULL OR NEW.erasure_reason IS NULL OR NEW.erasure_reference IS NULL THEN
    RAISE EXCEPTION 'history rows change only by an erasure with a recorded reason' USING ERRCODE = '42501';
  END IF;
  FOREACH v_column IN ARRAY v_erasable LOOP
    IF NOT (to_jsonb(NEW) ? v_column) THEN
      RAISE EXCEPTION 'unknown erasable column %', v_column;
    END IF;
    IF to_jsonb(NEW) -> v_column <> 'null'::jsonb THEN
      RAISE EXCEPTION 'erasure must clear column %', v_column USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF (to_jsonb(NEW) - (v_erasable || v_tombstone)) IS DISTINCT FROM (to_jsonb(OLD) - (v_erasable || v_tombstone)) THEN
    RAISE EXCEPTION 'only erasable columns may change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION kernel.history_guard() FROM PUBLIC;
