import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../../src/config/app-config.js';
import { currentContext } from '../../src/kernel/context/context-store.js';
import { uuidv7 } from '../../src/kernel/ids.js';
import { defineSubscription } from '../../src/kernel/outbox/subscriptions.js';
import { verifyAuditChain } from '../../src/kernel/audit/audit-writer.js';
import { DepartmentCreated } from '../../src/modules/tenancy/public/index.js';
import {
  TENANCY_MANIFEST,
  type TenancyTables,
} from '../../src/modules/tenancy/tenancy.manifest.js';
import { defineWorkflowAction } from '../../src/modules/workflow/public/index.js';
import { CONSUMER_GRANTS, WorkerRuntime } from '../../src/platform/worker/worker-runtime.js';
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
let orgB: string;
let adminA: string;
const A1 = uuidv7();
const B1 = uuidv7();
const org = (id: string) => `/v1/organizations/${id}`;

// ---- Test-only consumers and actions (the engine is a framework: modules register these) ----
const seen: {
  orgs: string[];
  actors: string[];
  onBehalfOf: (string | null)[];
  correlations: string[];
  foreignRows: number[];
} = {
  orgs: [],
  actors: [],
  onBehalfOf: [],
  correlations: [],
  foreignRows: [],
};
let failuresLeft = 0;
let effects = 0;

function registerTestSubscriptions(): void {
  defineSubscription<TenancyTables>({
    name: 'test.department_observer',
    manifest: TENANCY_MANIFEST,
    events: [DepartmentCreated],
    permissions: ['tenant:department:read'],
    maxReceives: 2,
    handle: async (envelope, tx) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('simulated handler failure');
      }
      const ctx = currentContext();
      seen.orgs.push(ctx.tenant.organizationId);
      seen.actors.push(ctx.actor.id);
      seen.onBehalfOf.push(ctx.onBehalfOf?.id ?? null);
      seen.correlations.push(`${ctx.correlationId}|${envelope.correlation_id}`);
      // H-JOB-02: a consumer in OrgA's context reads no OrgB rows.
      const foreign = await tx.db
        .selectFrom('app.tenant_department')
        .select('id')
        .where('organization_id', '=', orgB)
        .execute();
      seen.foreignRows.push(foreign.length);
      effects += 1;
    },
  });
  defineSubscription<TenancyTables>({
    name: 'test.ungranted',
    manifest: TENANCY_MANIFEST,
    events: [DepartmentCreated],
    permissions: ['tenant:department:manage'],
    handle: () => Promise.resolve(),
  });
}

let flakyRuns = 0;
defineWorkflowAction({
  name: 'test.read_departments',
  permission: 'tenant:department:read',
  run: () => Promise.resolve({ ok: true }),
});
defineWorkflowAction({
  name: 'test.flaky',
  permission: 'tenant:department:read',
  run: () => {
    flakyRuns += 1;
    if (flakyRuns === 1) return Promise.reject(new Error('transient failure'));
    return Promise.resolve({ runs: flakyRuns });
  },
});

async function drain(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await worker.tick();
}

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
  ({ organizationId: orgA, adminToken: adminA } = await provisionTenant(h, [A1], 'p3-admin-a'));
  ({ organizationId: orgB } = await provisionTenant(h, [B1], 'p3-admin-b'));
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
    {
      ...CONSUMER_GRANTS,
      'test.department_observer': ['tenant:department:read'],
      'test.ungranted': ['tenant:department:read'],
    },
    { backoffBaseMs: 1, backoffCapMs: 5, visibilityMs: 2_000 },
  );
  registerTestSubscriptions();
  await drain(); // drains provisioning events
});
afterAll(async () => {
  await worker.stop();
  await h.close();
});

describe('Outbox, relay, consumers and inbox (D-018; H-JOB)', () => {
  it('H-JOB-01 and 02: the consumer runs in the event tenant, as its own identity, on behalf of the actor', async () => {
    effects = 0;
    const created = await call<{ id: string }>(
      h,
      'POST',
      `${org(orgA)}/properties/${A1}/departments`,
      { token: adminA, body: { code: 'HK', name: 'Housekeeping' } },
    );
    expect(created.status).toBe(201);
    await drain();
    expect(effects).toBe(1);
    expect(seen.orgs.at(-1)).toBe(orgA);
    expect(seen.actors.at(-1)).not.toBe(seen.onBehalfOf.at(-1));
    expect(seen.onBehalfOf.at(-1)).not.toBeNull();
    const [ctxCorrelation, envelopeCorrelation] = (seen.correlations.at(-1) ?? '|').split('|');
    expect(ctxCorrelation).toBe(envelopeCorrelation);
    expect(seen.foreignRows.at(-1)).toBe(0);
  });

  it('H-JOB-06: the same event delivered twice has one business effect', async () => {
    effects = 0;
    await call(h, 'POST', `${org(orgA)}/properties/${A1}/departments`, {
      token: adminA,
      body: { code: 'MT', name: 'Maintenance' },
    });
    await worker.relay.relayBatch();
    // Duplicate the delivered message (at-least-once delivery) before the consumer runs.
    await admin((c) =>
      c.query(`INSERT INTO eventing.queue_message (id, queue, message_group, body, enqueued_at, visible_at)
      SELECT gen_random_uuid(), queue, message_group || '-dup', body, clock_timestamp(), clock_timestamp()
        FROM eventing.queue_message WHERE queue = 'test.department_observer'`),
    );
    await drain();
    expect(effects).toBe(1);
  });

  it('H-JOB-05: a consumer without a granted permission is denied, dead-lettered and the denial recorded', async () => {
    const rows = await admin((c) =>
      c.query(
        "SELECT reason FROM eventing.dead_letter WHERE queue = 'test.ungranted' AND organization_id = $1",
        [orgA],
      ),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((r: { reason: string }) => r.reason === 'permission_denied')).toBe(true);
    const audit = await admin((c) =>
      c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit.audit_record WHERE organization_id = $1 AND action = 'iam.authorization.denied'",
        [orgA],
      ),
    );
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
  });

  it('H-JOB-03: an event for an unknown tenant is not processed and goes to the dead-letter path', async () => {
    const unknownOrg = uuidv7();
    const envelope = {
      event_id: uuidv7(),
      type: 'tenant.department.created',
      version: 1,
      organization_id: unknownOrg,
      property_id: null,
      occurred_at: new Date().toISOString(),
      correlation_id: uuidv7(),
      causation_id: null,
      actor: { id: uuidv7(), realm: 'machine', kind: 'service_identity' },
      on_behalf_of_id: null,
      ordering_key: unknownOrg,
      payload: { department_id: uuidv7(), property_id: uuidv7(), code: 'X', status: 'active' },
    };
    await admin((c) =>
      c.query(
        `INSERT INTO eventing.queue_message (id, queue, message_group, body, enqueued_at, visible_at)
      VALUES (gen_random_uuid(), 'test.department_observer', $1, $2, clock_timestamp(), clock_timestamp())`,
        [unknownOrg, JSON.stringify(envelope)],
      ),
    );
    effects = 0;
    await drain(2);
    expect(effects).toBe(0);
    const dead = await admin((c) =>
      c.query<{ reason: string }>(
        'SELECT reason FROM eventing.dead_letter WHERE organization_id = $1',
        [unknownOrg],
      ),
    );
    expect(dead.rows[0]?.reason).toBe('tenant_unknown');
  });

  it('failures retry with backoff, then dead-letter; a replay (audited) is processed', async () => {
    failuresLeft = 10;
    effects = 0;
    await call(h, 'POST', `${org(orgA)}/properties/${A1}/departments`, {
      token: adminA,
      body: { code: 'FB', name: 'Food' },
    });
    for (let i = 0; i < 6; i += 1) {
      await worker.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(effects).toBe(0);
    const list = await call<{
      data: { id: string; queue: string; reason: string; version: number }[];
    }>(h, 'GET', `${org(orgA)}/dead-letters?status=dead`, { token: adminA });
    const dead = list.body.data.find(
      (d) => d.queue === 'test.department_observer' && d.reason === 'max_receives_exceeded',
    );
    expect(dead).toBeDefined();
    failuresLeft = 0;
    const replay = await call(h, 'POST', `${org(orgA)}/dead-letters/${dead?.id}/replay`, {
      token: adminA,
      headers: { 'if-match': `"${dead?.version}"` },
    });
    expect(replay.status).toBe(200);
    await drain();
    expect(effects).toBe(1);
  });
});

describe('Workflows, approvals, permission boundaries, scheduling and triggers (P3)', () => {
  async function definition(
    code: string,
    steps: unknown[],
    trigger: string | null = null,
  ): Promise<void> {
    const created = await call<{ id: string }>(h, 'POST', `${org(orgA)}/workflow-definitions`, {
      token: adminA,
      body: { code, name: code, steps, trigger_event: trigger },
    });
    expect(created.status).toBe(201);
    expect(
      (
        await call(h, 'POST', `${org(orgA)}/workflow-definitions/${created.body.id}/publish`, {
          token: adminA,
          headers: { 'if-match': '"1"' },
        })
      ).status,
    ).toBe(200);
  }
  async function start(code: string, tokenValue = adminA): Promise<string> {
    const started = await call<{ id: string }>(h, 'POST', `${org(orgA)}/workflow-instances`, {
      token: tokenValue,
      body: { definition_code: code, property_id: A1 },
    });
    expect(started.status).toBe(201);
    return started.body.id;
  }
  const instance = (id: string) =>
    call<{
      instance: { state: string; last_error: string | null };
      history: { outcome: string }[];
    }>(h, 'GET', `${org(orgA)}/workflow-instances/${id}`, { token: adminA });

  it('runs actions, waits for an approval, and completes after approval with a full history', async () => {
    await definition('approve_flow', [
      { key: 'check', type: 'action', action: 'test.read_departments' },
      { key: 'manager', type: 'approval', approval_type: 'general' },
      { key: 'finish', type: 'action', action: 'test.read_departments' },
    ]);
    const id = await start('approve_flow');
    await drain();
    expect((await instance(id)).body.instance.state).toBe('waiting_approval');
    const approvals = await call<{ data: { id: string; instance_id: string; version: number }[] }>(
      h,
      'GET',
      `${org(orgA)}/approvals?status=pending`,
      { token: adminA },
    );
    const approval = approvals.body.data.find((a) => a.instance_id === id);
    expect(
      (
        await call(h, 'POST', `${org(orgA)}/approvals/${approval?.id}/decision`, {
          token: adminA,
          body: { decision: 'approve' },
          headers: { 'if-match': `"${approval?.version}"` },
        })
      ).status,
    ).toBe(200);
    await drain();
    const done = await instance(id);
    expect(done.body.instance.state).toBe('completed');
    expect(done.body.history.map((e) => e.outcome)).toEqual([
      'started',
      'succeeded',
      'waiting_approval',
      'approved',
      'started',
      'succeeded',
    ]);
  });

  it('a rejected approval fails the instance', async () => {
    await definition('reject_flow', [
      { key: 'manager', type: 'approval', approval_type: 'general' },
    ]);
    const id = await start('reject_flow');
    await drain();
    const approvals = await call<{ data: { id: string; instance_id: string; version: number }[] }>(
      h,
      'GET',
      `${org(orgA)}/approvals?status=pending`,
      { token: adminA },
    );
    const approval = approvals.body.data.find((a) => a.instance_id === id);
    await call(h, 'POST', `${org(orgA)}/approvals/${approval?.id}/decision`, {
      token: adminA,
      body: { decision: 'reject' },
      headers: { 'if-match': `"${approval?.version}"` },
    });
    const failed = await instance(id);
    expect(failed.body.instance.state).toBe('failed');
    expect(failed.body.instance.last_error).toBe('workflow.approval_rejected');
  });

  it('a transient action failure retries with backoff, then succeeds', async () => {
    await definition('retry_flow', [
      {
        key: 'flaky',
        type: 'action',
        action: 'test.flaky',
        retry: { max_attempts: 3, backoff_seconds: 1 },
      },
    ]);
    const id = await start('retry_flow');
    await drain(2);
    expect((await instance(id)).body.instance.state).toBe('running');
    await new Promise((r) => setTimeout(r, 1_100));
    await drain(2);
    const done = await instance(id);
    expect(done.body.instance.state).toBe('completed');
    expect(done.body.history.map((e) => e.outcome)).toEqual([
      'started',
      'retrying',
      'started',
      'succeeded',
    ]);
  });

  it('permission boundary: an initiator without the action permission fails the step as denied', async () => {
    const role = await call<{ id: string }>(h, 'POST', `${org(orgA)}/roles`, {
      token: adminA,
      body: { code: 'starter', name: 'Starter', permissions: ['workflow:instance:start'] },
    });
    const invited = await call<{ user: { id: string }; invitation: { token: string } }>(
      h,
      'POST',
      `${org(orgA)}/users`,
      { token: adminA, body: { display_name: 'starter', realm: 'hotel_employee' } },
    );
    const starter = await token(h.staff, 'p3-starter');
    await call(h, 'POST', `${org(orgA)}/invitations/accept`, {
      token: starter,
      body: { token: invited.body.invitation.token },
    });
    await call(h, 'POST', `${org(orgA)}/role-assignments`, {
      token: adminA,
      body: {
        user_id: invited.body.user.id,
        role_id: role.body.id,
        scope_property_id: null,
        scope_department_id: null,
      },
    });
    const id = await start('approve_flow', starter);
    await drain();
    const result = await instance(id);
    expect(result.body.instance.state).toBe('failed');
    expect(result.body.instance.last_error).toBe('workflow.permission_denied');
    expect(result.body.history.map((e) => e.outcome)).toContain('denied');
  });

  it('a due scheduled task starts an instance on behalf of its owner', async () => {
    await definition('nightly', [
      { key: 'check', type: 'action', action: 'test.read_departments' },
    ]);
    const task = await call<{ id: string }>(h, 'POST', `${org(orgA)}/scheduled-tasks`, {
      token: adminA,
      body: { code: 'nightly-check', definition_code: 'nightly', interval_seconds: 3600 },
    });
    expect(task.status).toBe(201);
    await admin((c) =>
      c.query(
        "UPDATE app.wf_scheduled_task SET next_run_at = now() - interval '1 second' WHERE id = $1",
        [task.body.id],
      ),
    );
    const before = await admin((c) =>
      c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM app.wf_instance WHERE organization_id = $1',
        [orgA],
      ),
    );
    await drain();
    const after = await admin((c) =>
      c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM app.wf_instance WHERE organization_id = $1',
        [orgA],
      ),
    );
    expect(after.rows[0]?.n).toBe((before.rows[0]?.n ?? 0) + 1);
    const next = await admin((c) =>
      c.query<{ future: boolean }>(
        'SELECT next_run_at > now() AS future FROM app.wf_scheduled_task WHERE id = $1',
        [task.body.id],
      ),
    );
    expect(next.rows[0]?.future).toBe(true);
  });

  it('a published definition with a trigger event starts on the domain event', async () => {
    await definition(
      'on_department',
      [{ key: 'check', type: 'action', action: 'test.read_departments' }],
      'tenant.department.created',
    );
    await call(h, 'POST', `${org(orgA)}/properties/${A1}/departments`, {
      token: adminA,
      body: { code: 'TR', name: 'Triggered' },
    });
    await drain(5);
    const instances = await admin((c) =>
      c.query(
        `SELECT i.state FROM app.wf_instance i JOIN app.wf_definition d ON d.organization_id = i.organization_id AND d.id = i.definition_id
      WHERE i.organization_id = $1 AND d.code = 'on_department'`,
        [orgA],
      ),
    );
    expect(instances.rows.map((r: { state: string }) => r.state)).toEqual(['completed']);
  });

  it('the audit chain stays verifiable after all background work', async () => {
    const c = new pg.Client({ connectionString: urls.monitor });
    await c.connect();
    try {
      expect((await verifyAuditChain(c, orgA)).valid).toBe(true);
    } finally {
      await c.end();
    }
  });
});
