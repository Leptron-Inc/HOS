import type pg from 'pg';
import { verifyAuditChain } from '../../kernel/audit/audit-writer.js';
import { verifySecurityChain } from '../../kernel/audit/security-event-writer.js';
import { errorFields, type Logger, type MetricsRegistry } from '../../kernel/public.js';

/**
 * Independent integrity monitoring (tenancy specification E-46 items 4 and 5; map §7.2 scheduled
 * integrity check). Runs as hos_monitor, a read-only identity outside the application's write
 * paths. It DETECTS, after the fact, changes that the in-database controls cannot prevent against
 * privileged administrators; it does not prevent them. Items 1-3 of E-46 (break-glass credentials,
 * log export outside the administrator's reach, CloudTrail) need approved AWS resources (D-025).
 */
export interface IntegrityReport {
  readonly checkedAt: string;
  readonly auditChains: { organizationId: string; valid: boolean; records: number }[];
  readonly securityChain: { valid: boolean; records: number };
  readonly violations: { check: string; detail: string }[];
}

/** Tables whose every history version must have a matching audit record (E-46(5)). */
const AUDITED_HISTORIES = [
  'tenant_organization_history',
  'tenant_property_history',
  'tenant_department_history',
  'iam_user_history',
  'iam_role_history',
  'iam_role_assignment_history',
  'cfg_organization_setting_history',
  'cfg_property_setting_history',
  'int_connector_instance_history',
  'doc_document_history',
] as const;

const DEFINER_OWNER: readonly [RegExp, string][] = [
  [/_capture_version$/, 'hos_history_writer'],
  [/_history_sensitive$/, 'hos_history_reader'],
  [/_erase_history$/, 'hos_history_eraser'],
  [/^kernel\.(organization|property)_status$/, 'hos_lookup_tenant'],
  [/^kernel\.(resolve_principal|list_memberships)$/, 'hos_lookup_identity'],
  [/^kernel\.webhook_endpoint_lookup$/, 'hos_lookup_integration'],
];

export class IntegrityMonitor {
  constructor(
    private readonly monitorPool: pg.Pool,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry,
  ) {}

  async run(): Promise<IntegrityReport> {
    const violations: IntegrityReport['violations'] = [];
    const client = await this.monitorPool.connect();
    try {
      const orgs = await client.query<{ organization_id: string }>(
        'SELECT organization_id FROM audit.audit_chain_head ORDER BY organization_id LIMIT 100000',
      );
      const auditChains: IntegrityReport['auditChains'] = [];
      for (const { organization_id: organizationId } of orgs.rows) {
        const result = await verifyAuditChain(client, organizationId);
        auditChains.push({ organizationId, valid: result.valid, records: result.records });
        if (!result.valid)
          violations.push({
            check: 'audit_chain',
            detail: `organization ${organizationId} breaks at sequence ${result.firstInvalidSequence ?? '?'}`,
          });
      }
      const securityChain = await verifySecurityChain(client);
      if (!securityChain.valid)
        violations.push({
          check: 'security_chain',
          detail: `breaks after ${securityChain.records} records`,
        });

      const rls = await client.query<{ t: string }>(`
        SELECT c.oid::regclass::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'p')
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
      for (const row of rls.rows) violations.push({ check: 'forced_rls', detail: row.t });

      const triggers = await client.query<{ t: string }>(`
        SELECT c.oid::regclass::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app' AND c.relkind = 'r' AND c.relname LIKE '%\\_history'
           AND (SELECT count(*) FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND tg.tgname IN ('history_guard', 'history_no_truncate') AND tg.tgenabled = 'O') <> 2`);
      for (const row of triggers.rows) violations.push({ check: 'history_guard', detail: row.t });

      const definers = await client.query<{ name: string; owner: string }>(`
        SELECT n.nspname || '.' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef AND n.nspname IN ('app', 'hos_ctx', 'kernel', 'hos_migration', 'audit', 'eventing')`);
      for (const row of definers.rows) {
        const expected = DEFINER_OWNER.find(([pattern]) => pattern.test(row.name))?.[1];
        if (expected !== row.owner)
          violations.push({
            check: 'definer_function',
            detail: `${row.name} owned by ${row.owner}`,
          });
      }

      for (const table of AUDITED_HISTORIES) {
        const missing = await client.query<{ n: number }>(`
          SELECT count(*)::int AS n FROM app.${table} h
           WHERE NOT EXISTS (SELECT 1 FROM audit.audit_record a
                              WHERE a.organization_id = h.organization_id AND a.entity_id = h.entity_id AND a.entity_version = h.version)`);
        const n = missing.rows[0]?.n ?? 0;
        if (n > 0)
          violations.push({ check: 'history_without_audit', detail: `${table}: ${n} version(s)` });
      }

      for (const violation of violations) {
        this.metrics.increment('hos_integrity_violations_total', { check: violation.check });
        this.logger.error('integrity_violation', { check: violation.check });
      }
      this.metrics.set(
        'hos_integrity_last_run_timestamp_seconds',
        {},
        Math.floor(Date.now() / 1000),
      );
      this.metrics.set('hos_integrity_violations', {}, violations.length);
      return { checkedAt: new Date().toISOString(), auditChains, securityChain, violations };
    } catch (error) {
      this.metrics.increment('hos_integrity_monitor_failures_total', {});
      this.logger.error('integrity_monitor_failed', errorFields(error));
      throw error;
    } finally {
      client.release();
    }
  }
}
