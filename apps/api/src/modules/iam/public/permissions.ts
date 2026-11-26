/**
 * Permission catalogue (P2; D-021: HOS owns authorization). Each module declares the permissions
 * it checks; roles may contain only registered codes. Names follow the module map's proposed
 * names (`<module>:<resource>:<action>`); they become contracts with the identity and authorization
 * specification.
 */
export type PermissionScope = 'organization' | 'property' | 'department';

export interface PermissionDefinition {
  readonly code: string;
  readonly description: string;
  /** The narrowest assignment scope that can grant it. */
  readonly scopes: readonly PermissionScope[];
  /** false: held only by code-defined identities (for example the provisioning identity), never by roles. */
  readonly assignable?: boolean;
}

const CODE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$/;
const catalogue = new Map<string, PermissionDefinition>();

export function definePermissions(
  definitions: readonly PermissionDefinition[],
): readonly PermissionDefinition[] {
  for (const definition of definitions) {
    if (!CODE.test(definition.code)) throw new Error(`invalid permission code ${definition.code}`);
    const existing = catalogue.get(definition.code);
    if (existing !== undefined && existing !== definition)
      throw new Error(`permission ${definition.code} defined twice`);
    catalogue.set(definition.code, definition);
  }
  return definitions;
}

export function isRegisteredPermission(code: string): boolean {
  return catalogue.has(code);
}

export function isAssignablePermission(code: string): boolean {
  return catalogue.get(code)?.assignable !== false && catalogue.has(code);
}

export function permissionCatalogue(): readonly PermissionDefinition[] {
  return [...catalogue.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export const IAM_PERMISSIONS = definePermissions([
  {
    code: 'iam:user:read',
    description: 'List and read users and service identities',
    scopes: ['organization'],
  },
  {
    code: 'iam:user:manage',
    description:
      'Invite, deactivate and reactivate users; register service identities; revoke sessions',
    scopes: ['organization'],
  },
  {
    code: 'iam:role:read',
    description: 'Read roles and role assignments',
    scopes: ['organization', 'property'],
  },
  {
    code: 'iam:role:manage',
    description: 'Create and change roles and role assignments',
    scopes: ['organization'],
  },
]);
