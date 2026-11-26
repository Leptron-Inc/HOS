-- P1 Multi-Tenant Architecture: organization, property and department tables.
-- Source: tenancy specification rev 2.1, validated block 05, unchanged.
-- [validated 05 migration: P1 organization, property and department tables]
CREATE TABLE app.tenant_organization (
  id            uuid        PRIMARY KEY,
  display_name  text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL
);
ALTER TABLE app.tenant_organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_organization FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_organization AS PERMISSIVE FOR ALL TO hos_app
  USING (id = (SELECT hos_ctx.org_id()))
  WITH CHECK (id = (SELECT hos_ctx.org_id()));

CREATE TABLE app.tenant_property (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL REFERENCES app.tenant_organization (id),
  display_name     text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id)
);
ALTER TABLE app.tenant_property ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_property FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_property AS PERMISSIVE FOR ALL TO hos_app
  USING (organization_id = (SELECT hos_ctx.org_id())
         AND ((SELECT hos_ctx.all_properties()) OR id = ANY ((SELECT hos_ctx.property_ids())::uuid[])))
  WITH CHECK (organization_id = (SELECT hos_ctx.org_id())
         AND ((SELECT hos_ctx.all_properties()) OR id = ANY ((SELECT hos_ctx.property_ids())::uuid[])));

CREATE TABLE app.tenant_department (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  property_id      uuid        NOT NULL,
  code             text        NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name             text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_id, id),
  UNIQUE (organization_id, property_id, code),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('app.tenant_department', 'property');

GRANT SELECT, INSERT, UPDATE ON app.tenant_organization, app.tenant_property, app.tenant_department TO hos_app;

-- Pre-tenant lookups (C-12, C-21): named columns only, through a SELECT-only policy for the lookup owner role.
GRANT SELECT (id, status) ON app.tenant_organization TO hos_lookup_tenant;
GRANT SELECT (id, organization_id, status) ON app.tenant_property TO hos_lookup_tenant;
CREATE POLICY kernel_lookup ON app.tenant_organization AS PERMISSIVE FOR SELECT TO hos_lookup_tenant USING (true);
CREATE POLICY kernel_lookup ON app.tenant_property AS PERMISSIVE FOR SELECT TO hos_lookup_tenant USING (true);
