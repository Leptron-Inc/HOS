import {
  appendAudit,
  currentContext,
  decodeCursor,
  etag,
  NotFoundError,
  pageLimit,
  publishEvent,
  toPage,
  uuidv7,
  VersionConflictError,
  type IdempotencyStore,
  type IdempotentRequest,
  type Page,
  type RequestContext,
  type Selectable,
  type TenantDatabase,
  type TenantTx,
  type WriteResult,
} from '../../kernel/public.js';
import { requirePermission } from '../iam/public/authorizer.js';
import { TENANCY_MANIFEST, type TenancyTables } from './tenancy.manifest.js';
import {
  DepartmentCreated,
  DepartmentUpdated,
  OrganizationProvisioned,
  PropertyProvisioned,
  PropertyStatusChanged,
  type DepartmentView,
  type OrganizationView,
  type PropertyView,
} from './public/contracts.js';

type Tx = TenantTx<TenancyTables>;

function departmentView(row: Selectable<TenancyTables['app.tenant_department']>): DepartmentView {
  return {
    id: row.id,
    property_id: row.property_id,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * P1 Multi-Tenant Architecture services (module map P1; tenancy specification A-01 to A-22,
 * CX-15). Organizations and properties are created only through provisioning, with the Control
 * Plane's IDs; departments are managed by hotel administrators with `tenant:department:manage`.
 */
export class TenancyService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly idempotency: IdempotencyStore,
  ) {}

  // ---------- Provisioning (CX-15, H-PROV) ----------

  /** Idempotent: the same command returns the same organization (H-PROV-02). */
  async provisionOrganization(
    displayName: string,
  ): Promise<{ created: boolean; organization: OrganizationView }> {
    const ctx = currentContext();
    requirePermission('tenant:provision');
    return this.db.transaction<TenancyTables, { created: boolean; organization: OrganizationView }>(
      TENANCY_MANIFEST,
      async (tx) => {
        const id = ctx.tenant.organizationId;
        const existing = await tx.db
          .selectFrom('app.tenant_organization')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (existing === undefined) {
          await tx.db
            .insertInto('app.tenant_organization')
            .values({
              id,
              display_name: displayName,
              status: 'active',
              created_by: ctx.actor.id,
              updated_by: ctx.actor.id,
            })
            .execute();
          await this.audit(
            tx,
            'app.tenant_organization',
            'tenant.organization.provisioned',
            'organization',
            id,
            1,
            null,
            {
              display_name: { after: displayName },
              status: { after: 'active' },
            },
          );
          await publishEvent(tx, OrganizationProvisioned, { display_name: displayName });
          return {
            created: true,
            organization: { id, display_name: displayName, status: 'active', version: 1 },
          };
        }
        if (existing.display_name === displayName)
          return { created: false, organization: existing };
        const version = existing.version + 1;
        await tx.db
          .updateTable('app.tenant_organization')
          .set({
            display_name: displayName,
            version,
            updated_at: new Date(),
            updated_by: ctx.actor.id,
          })
          .where('id', '=', id)
          .where('version', '=', existing.version)
          .execute();
        await this.audit(
          tx,
          'app.tenant_organization',
          'tenant.organization.updated',
          'organization',
          id,
          version,
          null,
          {
            display_name: { before: existing.display_name, after: displayName },
          },
        );
        return {
          created: false,
          organization: { ...existing, display_name: displayName, version },
        };
      },
    );
  }

  async provisionProperty(
    propertyId: string,
    input: { displayName: string; status: 'active' | 'inactive' },
  ): Promise<{ created: boolean; property: PropertyView }> {
    const ctx = currentContext();
    requirePermission('tenant:provision');
    return this.db.transaction<TenancyTables, { created: boolean; property: PropertyView }>(
      TENANCY_MANIFEST,
      async (tx) => {
        const organizationId = ctx.tenant.organizationId;
        const organization = await tx.db
          .selectFrom('app.tenant_organization')
          .select('id')
          .where('id', '=', organizationId)
          .executeTakeFirst();
        if (organization === undefined) throw new NotFoundError();
        const existing = await tx.db
          .selectFrom('app.tenant_property')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', propertyId)
          .forUpdate()
          .executeTakeFirst();
        if (existing === undefined) {
          await tx.db
            .insertInto('app.tenant_property')
            .values({
              id: propertyId,
              organization_id: organizationId,
              display_name: input.displayName,
              status: input.status,
              created_by: ctx.actor.id,
              updated_by: ctx.actor.id,
            })
            .execute();
          await this.audit(
            tx,
            'app.tenant_property',
            'tenant.property.provisioned',
            'property',
            propertyId,
            1,
            propertyId,
            {
              display_name: { after: input.displayName },
              status: { after: input.status },
            },
          );
          await publishEvent(
            tx,
            PropertyProvisioned,
            { property_id: propertyId, display_name: input.displayName },
            { propertyId },
          );
          return {
            created: true,
            property: {
              id: propertyId,
              organization_id: organizationId,
              display_name: input.displayName,
              status: input.status,
              version: 1,
            },
          };
        }
        if (existing.display_name === input.displayName && existing.status === input.status)
          return { created: false, property: existing };
        const version = existing.version + 1;
        await tx.db
          .updateTable('app.tenant_property')
          .set({
            display_name: input.displayName,
            status: input.status,
            version,
            updated_at: new Date(),
            updated_by: ctx.actor.id,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', propertyId)
          .where('version', '=', existing.version)
          .execute();
        await this.audit(
          tx,
          'app.tenant_property',
          'tenant.property.updated',
          'property',
          propertyId,
          version,
          propertyId,
          {
            ...(existing.display_name !== input.displayName
              ? { display_name: { before: existing.display_name, after: input.displayName } }
              : {}),
            ...(existing.status !== input.status
              ? { status: { before: existing.status, after: input.status } }
              : {}),
          },
        );
        if (existing.status !== input.status) {
          await publishEvent(
            tx,
            PropertyStatusChanged,
            { property_id: propertyId, status: input.status, version },
            { propertyId },
          );
        }
        return {
          created: false,
          property: { ...existing, display_name: input.displayName, status: input.status, version },
        };
      },
    );
  }

  // ---------- Reads (A-18: "hosted in this cell") ----------

  async getOrganization(): Promise<OrganizationView> {
    requirePermission('tenant:property:read');
    return this.db.transaction<TenancyTables, OrganizationView>(TENANCY_MANIFEST, async (tx) => {
      const row = await tx.db
        .selectFrom('app.tenant_organization')
        .select(['id', 'display_name', 'status', 'version'])
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError();
      return row;
    });
  }

  /** Properties of the organization hosted in this cell that the caller's scope covers. */
  async listProperties(
    cursor: string | undefined,
    limitRaw: string | undefined,
  ): Promise<Page<PropertyView>> {
    const limit = pageLimit(limitRaw);
    const position = decodeCursor(cursor, { resource: 'properties' });
    return this.db.transaction<TenancyTables, Page<PropertyView>>(TENANCY_MANIFEST, async (tx) => {
      let query = tx.db
        .selectFrom('app.tenant_property')
        .select(['id', 'organization_id', 'display_name', 'status', 'version'])
        .orderBy('id')
        .limit(limit + 1);
      if (position !== null) query = query.where('id', '>', position.id);
      const rows = await query.execute();
      // Row-level security already limits rows to the context's property scope; P2 decides per property.
      const visible = rows.filter((row) => hasRead(row.id));
      return toPage(visible, limit, (row) => ({ sort: row.id, id: row.id }), {
        resource: 'properties',
      });
    });
  }

  // ---------- Departments (property-scoped routes, A-14) ----------

  async listDepartments(
    propertyId: string,
    cursor: string | undefined,
    limitRaw: string | undefined,
  ): Promise<Page<DepartmentView>> {
    requirePermission('tenant:department:read', { propertyId });
    const limit = pageLimit(limitRaw);
    const filters = { resource: 'departments', propertyId };
    const position = decodeCursor(cursor, filters);
    return this.db.transaction<TenancyTables, Page<DepartmentView>>(
      TENANCY_MANIFEST,
      async (tx) => {
        let query = tx.db
          .selectFrom('app.tenant_department')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .where('property_id', '=', propertyId)
          .orderBy('code')
          .orderBy('id')
          .limit(limit + 1);
        if (position !== null) {
          const sort = String(position.sort);
          query = query.where((eb) =>
            eb.or([
              eb('code', '>', sort),
              eb.and([eb('code', '=', sort), eb('id', '>', position.id)]),
            ]),
          );
        }
        const rows = await query.execute();
        return toPage(
          rows.map(departmentView),
          limit,
          (row) => ({ sort: row.code, id: row.id }),
          filters,
        );
      },
    );
  }

  async getDepartment(propertyId: string, departmentId: string): Promise<DepartmentView> {
    requirePermission('tenant:department:read', { propertyId });
    return this.db.transaction<TenancyTables, DepartmentView>(TENANCY_MANIFEST, async (tx) => {
      const row = await tx.db
        .selectFrom('app.tenant_department')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .where('property_id', '=', propertyId)
        .where('id', '=', departmentId)
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError();
      return departmentView(row);
    });
  }

  async createDepartment(
    propertyId: string,
    input: { code: string; name: string },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('tenant:department:manage', { propertyId });
    const ctx = currentContext();
    return this.db.transaction<TenancyTables, WriteResult>(TENANCY_MANIFEST, (tx) =>
      this.idempotency.run(tx, TENANCY_MANIFEST, request, async () => {
        const id = uuidv7();
        const row = await tx.db
          .insertInto('app.tenant_department')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            property_id: propertyId,
            code: input.code,
            name: input.name,
            status: 'active',
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit(
          tx,
          'app.tenant_department',
          'tenant.department.created',
          'department',
          id,
          1,
          propertyId,
          {
            code: { after: input.code },
            name: { after: input.name },
            status: { after: 'active' },
          },
        );
        await publishEvent(
          tx,
          DepartmentCreated,
          { department_id: id, property_id: propertyId, code: input.code, status: 'active' },
          { propertyId },
        );
        const view = departmentView(row);
        return {
          status: 201,
          headers: { etag: etag(view.version), location: departmentLocation(ctx, propertyId, id) },
          body: view,
        };
      }),
    );
  }

  /** E-19: conditional on the expected version; zero rows is a version conflict. */
  async updateDepartment(
    propertyId: string,
    departmentId: string,
    expectedVersion: number,
    changes: { name?: string | undefined; status?: 'active' | 'inactive' | undefined },
  ): Promise<DepartmentView> {
    requirePermission('tenant:department:manage', { propertyId });
    const ctx = currentContext();
    return this.db.transaction<TenancyTables, DepartmentView>(TENANCY_MANIFEST, async (tx) => {
      const current = await tx.db
        .selectFrom('app.tenant_department')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('property_id', '=', propertyId)
        .where('id', '=', departmentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError();
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
      const next = { name: changes.name ?? current.name, status: changes.status ?? current.status };
      const updated = await tx.db
        .updateTable('app.tenant_department')
        .set({
          ...next,
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', departmentId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) throw new VersionConflictError();
      const diff: Record<string, { before: unknown; after: unknown }> = {};
      if (next.name !== current.name) diff.name = { before: current.name, after: next.name };
      if (next.status !== current.status)
        diff.status = { before: current.status, after: next.status };
      await this.audit(
        tx,
        'app.tenant_department',
        'tenant.department.updated',
        'department',
        departmentId,
        updated.version,
        propertyId,
        diff,
      );
      await publishEvent(
        tx,
        DepartmentUpdated,
        {
          department_id: departmentId,
          property_id: propertyId,
          version: updated.version,
          status: updated.status,
        },
        { propertyId },
      );
      return departmentView(updated);
    });
  }

  /** For P2 (CX-19): which of these departments are active. Runs in its own transaction. */
  async activeDepartmentIds(
    ctx: RequestContext,
    departmentIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (departmentIds.length === 0) return new Set();
    return this.db.transactionFor<TenancyTables, ReadonlySet<string>>(
      ctx,
      TENANCY_MANIFEST,
      async (tx) => {
        const rows = await tx.db
          .selectFrom('app.tenant_department')
          .select('id')
          .where('organization_id', '=', ctx.tenant.organizationId)
          .where('id', 'in', [...departmentIds].slice(0, 1000))
          .where('status', '=', 'active')
          .execute();
        return new Set(rows.map((row) => row.id));
      },
    );
  }

  private audit(
    tx: Tx,
    table: string,
    action: string,
    entityType: string,
    entityId: string,
    version: number,
    propertyId: string | null,
    changes: Record<string, { before?: unknown; after?: unknown }>,
  ): Promise<string> {
    return appendAudit(tx, TENANCY_MANIFEST, {
      table,
      action,
      entityType,
      entityId,
      entityVersion: version,
      propertyId,
      changes,
    });
  }
}

function hasRead(propertyId: string): boolean {
  try {
    requirePermission('tenant:property:read', { propertyId });
    return true;
  } catch {
    return false;
  }
}

function departmentLocation(ctx: RequestContext, propertyId: string, id: string): string {
  return `/v1/organizations/${ctx.tenant.organizationId}/properties/${propertyId}/departments/${id}`;
}
