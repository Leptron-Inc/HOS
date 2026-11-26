/**
 * The public surface of the database kernel for modules (tenancy specification B-22, F-15).
 * Modules reach PostgreSQL only through TenantDatabase.transaction(); they never see a pool,
 * a connection or the driver. Enforced by .dependency-cruiser.cjs.
 */
export type {
  ColumnClass,
  ModuleManifest,
  RetentionClass,
  RuntimeRole,
  ScopeClass,
  TableManifest,
} from './manifest.js';
export { TableNotInManifestError } from './manifest.js';
// Type-only helpers for module table types; modules never import the query library itself.
export type {
  ColumnType,
  ExpressionBuilder,
  Generated,
  Insertable,
  Selectable,
  Updateable,
} from 'kysely';
export {
  ForbiddenStatementError,
  NestedTransactionError,
  TenantDatabase,
  type TenantTx,
} from './tenant-transaction.js';
export { TenantLookup, type LookupStatus } from './tenant-lookup.js';
export {
  isDatabaseError,
  isUniqueViolation,
  isPermissionDenied,
  isLockTimeout,
  isForeignKeyViolation,
} from './errors.js';
