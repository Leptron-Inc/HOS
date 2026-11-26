import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../../src/config/app-config.js';
import { uuidv7 } from '../../src/kernel/ids.js';
import { Logger, MetricsRegistry } from '../../src/kernel/public.js';
import { IntegrityMonitor } from '../../src/platform/worker/integrity-monitor.js';
import { WorkerRuntime } from '../../src/platform/worker/worker-runtime.js';
import { pool } from '../support/kernel-fixtures.js';
import {
  call,
  provisionTenant,
  startHarness,
  token,
  type Harness,
} from '../support/http-harness.js';

const urls = inject('hosDb');
let h: Harness;
let worker: WorkerRuntime;
let orgA: string;
let adminA: string;
const A1 = uuidv7();
const org = (id: string) => `/v1/organizations/${id}`;

async function admin<T>(work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urls.admin });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  h = await startHarness(urls);
  ({ organizationId: orgA, adminToken: adminA } = await provisionTenant(h, [A1], 'p7-admin-a'));
  worker = new WorkerRuntime(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: urls.api,
      WORKER_DATABASE_URL: urls.worker,
      RELAY_DATABASE_URL: urls.relay,
      SECLOG_DATABASE_URL: urls.seclog,
      HOS_CELL_ID: 'test-cell',
      LOG_LEVEL: 'error',
    }),
  );
});
afterAll(async () => {
  await worker.stop();
  await h.close();
});

describe('P7 audit access and compliance evidence', () => {
  it("lists the tenant's audit records and verifies its chain; other tenants are not visible", async () => {
    const records = await call<{ data: { action: string; payload: unknown }[] }>(
      h,
      'GET',
      `${org(orgA)}/audit-records?limit=200`,
      { token: adminA },
    );
    expect(records.status).toBe(200);
    expect(records.body.data.map((r) => r.action)).toContain('tenant.organization.provisioned');
    const verification = await call<{ valid: boolean; records: number }>(
      h,
      'GET',
      `${org(orgA)}/audit-records/verification`,
      { token: adminA },
    );
    expect(verification.body).toMatchObject({ valid: true });
    expect(verification.body.records).toBe(records.body.data.length);
  });

  it('audit reads require audit:read', async () => {
    const role = await call<{ id: string }>(h, 'POST', `${org(orgA)}/roles`, {
      token: adminA,
      body: { code: 'reader', name: 'Reader', permissions: ['tenant:property:read'] },
    });
    const invited = await call<{ user: { id: string }; invitation: { token: string } }>(
      h,
      'POST',
      `${org(orgA)}/users`,
      { token: adminA, body: { display_name: 'Reader Person', realm: 'hotel_employee' } },
    );
    const reader = await token(h.staff, 'p7-reader');
    await call(h, 'POST', `${org(orgA)}/invitations/accept`, {
      token: reader,
      body: { token: invited.body.invitation.token },
    });
    await call(h, 'POST', `${org(orgA)}/role-assignments`, {
      token: adminA,
      body: { user_id: invited.body.user.id, role_id: role.body.id },
    });
    expect((await call(h, 'GET', `${org(orgA)}/audit-records`, { token: reader })).status).toBe(
      403,
    );
  });
});

describe('P7 data-subject erasure (E-34 to E-37)', () => {
  it('erases a user across the current record and every history version, leaving tombstones, and completes', async () => {
    const invited = await call<{ user: { id: string } }>(h, 'POST', `${org(orgA)}/users`, {
      token: adminA,
      body: { display_name: 'Erase Me Please', realm: 'guest' },
    });
    const userId = invited.body.user.id;
    const created = await call<{ id: string; status: string }>(
      h,
      'POST',
      `${org(orgA)}/data-requests`,
      {
        token: adminA,
        body: { request_type: 'erasure', subject_type: 'user', subject_id: userId },
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('processing');
    for (let i = 0; i < 4; i += 1) await worker.tick();
    const request = await call<{ status: string; completed_modules: string[] }>(
      h,
      'GET',
      `${org(orgA)}/data-requests/${created.body.id}`,
      { token: adminA },
    );
    expect(request.body).toMatchObject({ status: 'completed', completed_modules: ['iam'] });
    await admin(async (c) => {
      const current = await c.query(
        'SELECT display_name, idp_issuer, status FROM app.iam_user WHERE id = $1',
        [userId],
      );
      expect(current.rows[0]).toMatchObject({
        display_name: '[erased]',
        idp_issuer: 'urn:hos:erased',
        status: 'inactive',
      });
      const history = await c.query<{
        display_name: string | null;
        erased_at: Date | null;
        erasure_reason: string | null;
        erasure_reference: string | null;
      }>(
        'SELECT display_name, erased_at, erasure_reason, erasure_reference FROM app.iam_user_history WHERE entity_id = $1',
        [userId],
      );
      expect(history.rows.length).toBeGreaterThan(1);
      for (const row of history.rows) {
        expect(row.display_name).toBeNull();
        expect(row.erasure_reason).toBe('data_subject_request');
        expect(row.erasure_reference).toBe(created.body.id);
        expect(row.erased_at).not.toBeNull();
      }
      // The audit trail never held the name, so it stays intact (map §1.1).
      const audit = await c.query('SELECT payload FROM audit.audit_record WHERE entity_id = $1', [
        userId,
      ]);
      expect(JSON.stringify(audit.rows)).not.toMatch(/Erase Me Please/);
    });
  });
});

describe('Independent integrity monitoring (E-46 items 4 and 5)', () => {
  it('reports a healthy cell, then detects tampering by a privileged administrator', async () => {
    const monitorPool = pool(urls.monitor, 2);
    const metrics = new MetricsRegistry();
    const monitor = new IntegrityMonitor(
      monitorPool,
      new Logger('test', 'error', { write: () => undefined }),
      metrics,
    );
    try {
      const healthy = await monitor.run();
      // The P1 kernel tests seed fixtures directly through the kernel without service-level audit;
      // the monitor rightly reports that history as unaudited. Everything else must be clean.
      expect(healthy.violations.filter((v) => v.check !== 'history_without_audit')).toEqual([]);
      expect(healthy.auditChains.every((chain) => chain.valid)).toBe(true);
      expect(healthy.securityChain.valid).toBe(true);
      const unauditedBefore =
        healthy.violations.find((v) => v.detail.startsWith('iam_role_history'))?.detail ??
        'iam_role_history: 0 version(s)';

      // A separate organization is tampered with, as a superuser could (the guard does not bind superusers, E-44).
      const { organizationId: victim } = await provisionTenant(h, [uuidv7()], 'p7-victim');
      await admin(async (c) => {
        await c.query(
          'UPDATE audit.audit_record SET payload = \'{"display_name":{"after":"forged"}}\' WHERE organization_id = $1 AND sequence = 1',
          [victim],
        );
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query('DELETE FROM audit.audit_record WHERE organization_id = $1 AND action = $2', [
          victim,
          'iam.role.created',
        ]);
        await c.query('COMMIT');
        await c.query('ALTER TABLE app.tenant_department_history DISABLE TRIGGER history_guard');
      });
      const tampered = await monitor.run();
      const checks = new Set(tampered.violations.map((v) => v.check));
      expect(checks.has('audit_chain')).toBe(true);
      const unauditedAfter =
        tampered.violations.find((v) => v.detail.startsWith('iam_role_history'))?.detail ?? '';
      expect(Number(/: (\d+)/.exec(unauditedAfter)?.[1])).toBe(
        Number(/: (\d+)/.exec(unauditedBefore)?.[1]) + 1,
      );
      expect(checks.has('history_guard')).toBe(true);
      expect(
        metrics.counterValue('hos_integrity_violations_total', { check: 'audit_chain' }),
      ).toBeGreaterThan(0);
    } finally {
      await admin((c) =>
        c.query('ALTER TABLE app.tenant_department_history ENABLE TRIGGER history_guard'),
      );
      await monitorPool.end();
    }
  });
});
