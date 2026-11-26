-- Platform (P1 kernel, L0): context functions and platform privileges.
-- Source: tenancy specification rev 2.1, validated block 03, unchanged.
-- [validated 03 migration: platform privileges and context functions]
ALTER DEFAULT PRIVILEGES FOR ROLE hos_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA app, hos_ctx, kernel TO hos_app;
GRANT USAGE ON SCHEMA app TO hos_lookup_tenant, hos_lookup_identity;
GRANT USAGE ON SCHEMA app, hos_ctx TO hos_history_writer, hos_history_reader, hos_history_eraser;
GRANT USAGE, CREATE ON SCHEMA kernel
  TO hos_lookup_tenant, hos_lookup_identity, hos_history_writer, hos_history_reader, hos_history_eraser;

CREATE FUNCTION hos_ctx.org_id() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text := current_setting('hos.organization_id', true);
BEGIN
  -- After a transaction ends, a defined setting reads as '' rather than NULL.
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'tenant context missing' USING ERRCODE = '42501';
  END IF;
  RETURN v::uuid;
END $$;

CREATE FUNCTION hos_ctx.all_properties() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text := current_setting('hos.property_scope', true);
BEGIN
  IF v = 'all'  THEN RETURN true;  END IF;
  IF v = 'list' THEN RETURN false; END IF;
  RAISE EXCEPTION 'property scope missing' USING ERRCODE = '42501';
END $$;

CREATE FUNCTION hos_ctx.property_ids() RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(nullif(current_setting('hos.property_ids', true), ''), '{}')::uuid[]
$$;

GRANT EXECUTE ON FUNCTION hos_ctx.org_id(), hos_ctx.all_properties(), hos_ctx.property_ids()
  TO hos_app, hos_history_writer, hos_history_reader, hos_history_eraser;
