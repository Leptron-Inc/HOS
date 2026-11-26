-- P1 Multi-Tenant Architecture: pre-tenant lookup functions (C-12, C-21).
-- Source: tenancy specification rev 2.1, validated block 07, unchanged.
-- [validated 07 migration: P1 pre-tenant lookup functions]
SET ROLE hos_lookup_tenant;           -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.organization_status(p_organization_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT o.status FROM app.tenant_organization AS o WHERE o.id = p_organization_id),
    'not_found')
$$;
REVOKE ALL ON FUNCTION kernel.organization_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.organization_status(uuid) TO hos_app;

CREATE FUNCTION kernel.property_status(p_organization_id uuid, p_property_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT p.status FROM app.tenant_property AS p
      WHERE p.id = p_property_id AND p.organization_id = p_organization_id),
    'not_found')
$$;
REVOKE ALL ON FUNCTION kernel.property_status(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.property_status(uuid, uuid) TO hos_app;
SET ROLE hos_owner;
