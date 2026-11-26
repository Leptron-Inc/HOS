import type pg from 'pg';
import { canonicalJson, GENESIS_HASH, sha256 } from '../canonical-json.js';
import { isUuid, uuidv7 } from '../ids.js';

/**
 * P7 security-event writer (kernel layer L1; module map §7.2). Records denials that happen before
 * any tenant-scoped database access in the cell-level system security log, using the dedicated
 * hos_seclog_writer role (INSERT on the log; it cannot read the log). Fields are an allowlist;
 * reasons are fixed codes; untrusted values are labelled and never looked up.
 *
 * A rejection never depends on logging: record() never throws. A failed write raises an
 * operational alert through onWriteFailure (P6).
 */
export type DenialOutcome =
  'authn_failed' | 'context_missing' | 'tenant_unknown' | 'authz_denied' | 'context_mismatch';
export type TenantStatus = 'verified_not_authorized' | 'unknown' | 'not_provided' | 'not_evaluated';

export const REASON_CODES: Readonly<Record<DenialOutcome, readonly string[]>> = {
  authn_failed: [
    'credential_missing',
    'credential_malformed',
    'token_expired',
    'token_not_yet_valid',
    'signature_invalid',
    'issuer_unknown',
    'audience_invalid',
    'realm_not_allowed',
    'principal_unknown',
    'principal_inactive',
    'session_revoked',
    'key_unknown',
  ],
  context_missing: ['route_scope_missing', 'tenant_route_parameter_missing', 'tenant_id_malformed'],
  tenant_unknown: [
    'organization_not_found',
    'property_not_found',
    'organization_inactive',
    'property_inactive',
    'webhook_endpoint_unknown',
  ],
  authz_denied: [
    'no_role_in_scope',
    'permission_missing',
    'realm_mismatch',
    'provisioning_scope_only',
    'machine_scope',
  ],
  context_mismatch: [
    'payload_tenant_mismatch',
    'payload_property_mismatch',
    'webhook_account_mismatch',
  ],
};

export interface Denial {
  readonly component: string;
  /** Route template only, never path values or a query string. */
  readonly routeTemplate: string | null;
  readonly httpMethod: string | null;
  readonly outcome: DenialOutcome;
  readonly reason: string;
  readonly requestId: string;
  /** Only when authentication succeeded. */
  readonly actor: {
    readonly id: string;
    readonly realm: 'hotel_employee' | 'guest' | 'machine';
  } | null;
  readonly tenantStatus: TenantStatus;
  /** Only when tenantStatus is verified_not_authorized (map §7.2). */
  readonly targetTenantId: string | null;
  /** The caller's claim; kept only if it is a well-formed ID; never looked up. */
  readonly claimedTenantUntrusted: string | null;
  readonly clientCorrelationUntrusted: string | null;
  readonly sourceAddress: string | null;
}

export interface FidelityScope {
  readonly sourceAddress?: string;
  readonly routeTemplate?: string;
  readonly claimedTenant?: string;
}

export interface SecurityEventWriterOptions {
  readonly cellId: string;
  readonly writerInstance: string;
  /** Aggregation window for denials without a verified actor (short and fixed, map §7.2). */
  readonly aggregationWindowMs: number;
  readonly onWriteFailure: (reason: string) => void;
  readonly now?: () => Date;
}

interface Pending {
  readonly firstOccurrenceId: string;
  readonly template: Denial;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export class SecurityEventWriter {
  private readonly pending = new Map<string, Pending>();
  private readonly firstSeen = new Map<string, string>();
  private fidelity: { scope: FidelityScope; until: Date } | null = null;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: SecurityEventWriterOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Records one denial. Never throws (a rejection never depends on logging). */
  async record(denial: Denial): Promise<void> {
    try {
      const clean = this.sanitize(denial);
      const verifiedActor = clean.actor !== null;
      const aggregatable =
        !verifiedActor &&
        (clean.outcome === 'authn_failed' ||
          clean.outcome === 'context_missing' ||
          clean.outcome === 'tenant_unknown');
      if (!aggregatable || this.inFidelityScope(clean)) {
        await this.write('individual', clean, null);
        return;
      }
      const key = canonicalJson([
        clean.outcome,
        clean.reason,
        clean.routeTemplate,
        clean.sourceAddress,
        clean.claimedTenantUntrusted,
      ]);
      const first = this.firstSeen.get(key);
      if (first === undefined) {
        const id = await this.write('individual', clean, null);
        if (id !== undefined) this.firstSeen.set(key, id);
        return;
      }
      const now = this.now();
      const existing = this.pending.get(key);
      if (existing === undefined) {
        this.pending.set(key, {
          firstOccurrenceId: first,
          template: clean,
          count: 1,
          firstSeen: now,
          lastSeen: now,
        });
        this.schedule();
      } else {
        existing.count += 1;
        existing.lastSeen = now;
      }
    } catch {
      this.options.onWriteFailure('security_event_record_failed');
    }
  }

  /** Appends one aggregate record per pending group; never updates an existing record. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const groups = [...this.pending.values()];
    this.pending.clear();
    for (const group of groups) {
      await this.write('aggregate', group.template, {
        firstOccurrenceId: group.firstOccurrenceId,
        count: group.count,
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
      });
    }
  }

  /** Full-fidelity mode for a scope and a limited time; the switch is itself recorded. */
  async setFidelityMode(
    scope: FidelityScope | null,
    until: Date | null,
    actor: Denial['actor'],
    requestId: string,
  ): Promise<void> {
    this.fidelity = scope === null || until === null ? null : { scope, until };
    await this.write(
      'mode_change',
      {
        component: 'security_log',
        routeTemplate: scope?.routeTemplate ?? null,
        httpMethod: null,
        outcome: 'fidelity_mode' as DenialOutcome,
        reason: scope === null ? 'disabled' : 'enabled',
        requestId,
        actor,
        tenantStatus: 'not_evaluated',
        targetTenantId: null,
        claimedTenantUntrusted:
          scope?.claimedTenant !== undefined && isUuid(scope.claimedTenant)
            ? scope.claimedTenant
            : null,
        clientCorrelationUntrusted: null,
        sourceAddress: scope?.sourceAddress ?? null,
      },
      null,
    );
  }

  async close(): Promise<void> {
    await this.flush();
    await this.chain;
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => this.options.onWriteFailure('security_event_flush_failed'));
    }, this.options.aggregationWindowMs);
    this.timer.unref();
  }

  private inFidelityScope(denial: Denial): boolean {
    const mode = this.fidelity;
    if (mode === null) return false;
    if (this.now() > mode.until) {
      this.fidelity = null;
      return false;
    }
    const s = mode.scope;
    return (
      (s.sourceAddress === undefined || s.sourceAddress === denial.sourceAddress) &&
      (s.routeTemplate === undefined || s.routeTemplate === denial.routeTemplate) &&
      (s.claimedTenant === undefined || s.claimedTenant === denial.claimedTenantUntrusted)
    );
  }

  private sanitize(denial: Denial): Denial {
    if (!REASON_CODES[denial.outcome]?.includes(denial.reason)) {
      throw new Error('reason code is not on the fixed list for this outcome');
    }
    if (denial.targetTenantId !== null && denial.tenantStatus !== 'verified_not_authorized') {
      throw new Error('a target tenant is recorded only when verified');
    }
    const correlation =
      denial.clientCorrelationUntrusted?.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128) ?? '';
    return {
      ...denial,
      routeTemplate:
        denial.routeTemplate === null
          ? null
          : (denial.routeTemplate.split('?')[0]?.slice(0, 300) ?? null),
      httpMethod:
        denial.httpMethod !== null && METHODS.has(denial.httpMethod) ? denial.httpMethod : null,
      requestId: denial.requestId.slice(0, 64),
      claimedTenantUntrusted: isUuid(denial.claimedTenantUntrusted)
        ? denial.claimedTenantUntrusted
        : null,
      clientCorrelationUntrusted: correlation === '' ? null : correlation,
    };
  }

  /** Writes one record in its own short transaction; serialized per writer instance. */
  private write(
    recordType: 'individual' | 'aggregate' | 'mode_change',
    denial: Denial,
    aggregate: { firstOccurrenceId: string; count: number; firstSeen: Date; lastSeen: Date } | null,
  ): Promise<string | undefined> {
    const run = async (): Promise<string | undefined> => {
      const client = await this.pool.connect();
      let broken: Error | undefined;
      const onError = (error: Error) => {
        broken = error;
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO audit.security_chain_head (chain_id, id, last_sequence, last_hash, updated_at)
           VALUES ('cell', $1, 0, $2, now()) ON CONFLICT (chain_id) DO NOTHING`,
          [uuidv7(), GENESIS_HASH],
        );
        const head = await client.query<{ last_sequence: number; last_hash: Buffer }>(
          "SELECT last_sequence, last_hash FROM audit.security_chain_head WHERE chain_id = 'cell' FOR UPDATE",
        );
        const previous = head.rows[0];
        if (previous === undefined) throw new Error('security chain head missing');
        const record = securityHashInput({
          id: uuidv7(),
          sequence: Number(previous.last_sequence) + 1,
          recorded_at: this.now().toISOString(),
          cell_id: this.options.cellId,
          component: denial.component,
          route_template: denial.routeTemplate,
          http_method: denial.httpMethod,
          record_type: recordType,
          outcome: denial.outcome,
          reason: denial.reason,
          request_id: denial.requestId,
          actor_id: denial.actor?.id ?? null,
          actor_realm: denial.actor?.realm ?? null,
          tenant_status: denial.tenantStatus,
          target_tenant_id: denial.targetTenantId,
          claimed_tenant_id_untrusted: denial.claimedTenantUntrusted,
          client_correlation_untrusted: denial.clientCorrelationUntrusted,
          source_address: denial.sourceAddress,
          first_occurrence_id: aggregate?.firstOccurrenceId ?? null,
          aggregate_count: aggregate?.count ?? null,
          first_seen_at: aggregate?.firstSeen.toISOString() ?? null,
          last_seen_at: aggregate?.lastSeen.toISOString() ?? null,
          writer_instance: this.options.writerInstance,
        });
        const hash = sha256(previous.last_hash, canonicalJson(record));
        await client.query(
          `INSERT INTO audit.security_event (id, sequence, recorded_at, cell_id, component, route_template, http_method,
             record_type, outcome, reason, request_id, actor_id, actor_realm, tenant_status, target_tenant_id,
             claimed_tenant_id_untrusted, client_correlation_untrusted, source_address, first_occurrence_id, aggregate_count,
             first_seen_at, last_seen_at, writer_instance, previous_hash, record_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
          [
            record.id,
            record.sequence,
            record.recorded_at,
            record.cell_id,
            record.component,
            record.route_template,
            record.http_method,
            record.record_type,
            record.outcome,
            record.reason,
            record.request_id,
            record.actor_id,
            record.actor_realm,
            record.tenant_status,
            record.target_tenant_id,
            record.claimed_tenant_id_untrusted,
            record.client_correlation_untrusted,
            record.source_address,
            record.first_occurrence_id,
            record.aggregate_count,
            record.first_seen_at,
            record.last_seen_at,
            record.writer_instance,
            previous.last_hash,
            hash,
          ],
        );
        await client.query(
          "UPDATE audit.security_chain_head SET last_sequence = $1, last_hash = $2, updated_at = now() WHERE chain_id = 'cell'",
          [record.sequence, hash],
        );
        await client.query('COMMIT');
        return record.id;
      } catch {
        await client.query('ROLLBACK').catch((error: unknown) => {
          broken = error instanceof Error ? error : new Error('rollback failed');
        });
        this.options.onWriteFailure('security_event_write_failed');
        return undefined;
      } finally {
        client.off('error', onError);
        client.release(broken);
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}

export interface SecurityHashInput {
  readonly id: string;
  readonly sequence: number;
  readonly recorded_at: string;
  readonly cell_id: string;
  readonly component: string;
  readonly route_template: string | null;
  readonly http_method: string | null;
  readonly record_type: string;
  readonly outcome: string;
  readonly reason: string;
  readonly request_id: string | null;
  readonly actor_id: string | null;
  readonly actor_realm: string | null;
  readonly tenant_status: string;
  readonly target_tenant_id: string | null;
  readonly claimed_tenant_id_untrusted: string | null;
  readonly client_correlation_untrusted: string | null;
  readonly source_address: string | null;
  readonly first_occurrence_id: string | null;
  readonly aggregate_count: number | null;
  readonly first_seen_at: string | null;
  readonly last_seen_at: string | null;
  readonly writer_instance: string;
}

export function securityHashInput(record: SecurityHashInput): SecurityHashInput {
  return record;
}

/** Verifies the cell security chain (scheduled integrity check, map §7.2). Run by hos_monitor. */
export async function verifySecurityChain(
  client: pg.ClientBase,
  batchSize = 1000,
): Promise<{ records: number; valid: boolean }> {
  let previous: Buffer = GENESIS_HASH;
  let expected = 1;
  for (;;) {
    const rows = await client.query<
      Record<string, unknown> & { sequence: number; previous_hash: Buffer; record_hash: Buffer }
    >(
      `SELECT id, sequence, recorded_at, cell_id, component, route_template, http_method, record_type, outcome, reason,
              request_id, actor_id, actor_realm, tenant_status, target_tenant_id, claimed_tenant_id_untrusted,
              client_correlation_untrusted, host(source_address) AS source_address, first_occurrence_id, aggregate_count,
              first_seen_at, last_seen_at, writer_instance, previous_hash, record_hash
         FROM audit.security_event WHERE sequence >= $1 ORDER BY sequence LIMIT $2`,
      [expected, batchSize],
    );
    if (rows.rows.length === 0) break;
    for (const row of rows.rows) {
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
      const input: SecurityHashInput = {
        id: row.id as string,
        sequence: Number(row.sequence),
        recorded_at: iso(row.recorded_at) ?? '',
        cell_id: row.cell_id as string,
        component: row.component as string,
        route_template: row.route_template as string | null,
        http_method: row.http_method as string | null,
        record_type: row.record_type as string,
        outcome: row.outcome as string,
        reason: row.reason as string,
        request_id: row.request_id as string | null,
        actor_id: row.actor_id as string | null,
        actor_realm: row.actor_realm as string | null,
        tenant_status: row.tenant_status as string,
        target_tenant_id: row.target_tenant_id as string | null,
        claimed_tenant_id_untrusted: row.claimed_tenant_id_untrusted as string | null,
        client_correlation_untrusted: row.client_correlation_untrusted as string | null,
        source_address: row.source_address as string | null,
        first_occurrence_id: row.first_occurrence_id as string | null,
        aggregate_count: row.aggregate_count as number | null,
        first_seen_at: iso(row.first_seen_at),
        last_seen_at: iso(row.last_seen_at),
        writer_instance: row.writer_instance as string,
      };
      if (
        Number(row.sequence) !== expected ||
        !row.previous_hash.equals(previous) ||
        !sha256(previous, canonicalJson(input)).equals(row.record_hash)
      ) {
        return { records: expected - 1, valid: false };
      }
      previous = row.record_hash;
      expected += 1;
    }
  }
  return { records: expected - 1, valid: true };
}
