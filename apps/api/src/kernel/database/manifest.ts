/**
 * Module table manifests (tenancy specification B-04 to B-07, E-26, E-30, C-03). Every table a
 * module owns is declared here with its scope class, column classification and retention class.
 * The data-access layer checks every query against the calling module's manifest (B-07), and the
 * catalog tests compare all manifests with the database (H-MIG-04, B-06).
 */
export type ScopeClass = 'organization' | 'property' | 'global_reference' | 'system';
export type ColumnClass = 'public' | 'internal' | 'personal' | 'sensitive' | 'secret';
export type RetentionClass = 'transient' | 'operational' | 'financial' | 'security' | 'audit';
export type RuntimeRole =
  'hos_api' | 'hos_worker' | 'hos_relay' | 'hos_seclog_writer' | 'hos_monitor';

export interface TableManifest {
  /** Schema-qualified name, for example `app.tenant_department`. */
  readonly table: string;
  readonly scope: ScopeClass;
  readonly retention: RetentionClass;
  /** Versioned entities keep a history table (E-20). */
  readonly history?: string;
  /** Every column with its classification (E-26). `secret` is never allowed (E-26). */
  readonly columns: Readonly<Record<string, ColumnClass>>;
  /** Runtime roles with DELETE (C-03, E-17). Empty for most tables. */
  readonly deletableBy?: readonly RuntimeRole[];
  /** Kernel-owned tables are written only by kernel writers (B-07 exceptions). */
  readonly kernelOwned?: boolean;
  /** Indexes allowed to lead with something other than organization_id (B-13 exceptions). */
  readonly lookupIndexes?: readonly string[];
}

export interface ModuleManifest {
  /** Module key, for example `tenant` (P1) or `iam` (P2). */
  readonly module: string;
  /** Unique table prefix (B-04), for example `tenant_`. */
  readonly prefix: string;
  readonly tables: readonly TableManifest[];
  /**
   * Classified fields of audited facts that are not table rows (for example an authorization
   * denial). The audit writer redacts them exactly like table columns.
   */
  readonly auditRecords?: Readonly<Record<string, Readonly<Record<string, ColumnClass>>>>;
}

export class TableNotInManifestError extends Error {
  constructor(module: string, table: string) {
    super(`Module ${module} may not access ${table}: it is not in the module's manifest (B-07)`);
    this.name = 'TableNotInManifestError';
  }
}

export function tableSet(manifest: ModuleManifest): ReadonlySet<string> {
  const names = new Set<string>();
  for (const table of manifest.tables) {
    if (!table.kernelOwned) names.add(table.table);
    // History tables are readable (non-sensitive columns) by their owning module (E-23).
    if (table.history !== undefined) names.add(table.history);
  }
  return names;
}
