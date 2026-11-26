import { defineEvent, z } from '../../../kernel/public.js';
import { definePermissions } from '../../iam/public/permissions.js';

/** P1 public interface: events, permissions and the service contract other modules may use (F-15). */
export const TENANCY_PERMISSIONS = definePermissions([
  {
    code: 'tenant:provision',
    description: 'Create or update organizations and properties (provisioning identity only)',
    scopes: ['organization'],
    assignable: false,
  },
  {
    code: 'tenant:property:read',
    description: 'Read the organization and its properties hosted in this cell',
    scopes: ['organization', 'property'],
  },
  {
    code: 'tenant:department:read',
    description: 'Read departments',
    scopes: ['organization', 'property'],
  },
  {
    code: 'tenant:department:manage',
    description: 'Create, update and deactivate departments',
    scopes: ['organization', 'property'],
  },
]);

const status = z.enum(['active', 'inactive']);
export const OrganizationProvisioned = defineEvent({
  type: 'tenant.organization.provisioned',
  version: 1,
  schema: z.strictObject({ display_name: z.string().max(200) }),
});
export const PropertyProvisioned = defineEvent({
  type: 'tenant.property.provisioned',
  version: 1,
  schema: z.strictObject({ property_id: z.string().uuid(), display_name: z.string().max(200) }),
});
export const PropertyStatusChanged = defineEvent({
  type: 'tenant.property.status_changed',
  version: 1,
  schema: z.strictObject({ property_id: z.string().uuid(), status, version: z.number().int() }),
});
export const DepartmentCreated = defineEvent({
  type: 'tenant.department.created',
  version: 1,
  schema: z.strictObject({
    department_id: z.string().uuid(),
    property_id: z.string().uuid(),
    code: z.string().max(64),
    status,
  }),
});
export const DepartmentUpdated = defineEvent({
  type: 'tenant.department.updated',
  version: 1,
  schema: z.strictObject({
    department_id: z.string().uuid(),
    property_id: z.string().uuid(),
    version: z.number().int(),
    status,
  }),
});

export interface OrganizationView {
  readonly id: string;
  readonly display_name: string;
  readonly status: 'active' | 'inactive';
  readonly version: number;
}

export interface PropertyView extends OrganizationView {
  readonly organization_id: string;
}

export interface DepartmentView {
  readonly id: string;
  readonly property_id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}
