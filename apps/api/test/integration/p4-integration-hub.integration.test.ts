import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/kernel/ids.js';
import {
  call,
  lastSecuritySequence,
  provisionTenant,
  securityEvents,
  startHarness,
  token,
  type Harness,
} from '../support/http-harness.js';

const urls = inject('hosDb');
let h: Harness;
let orgA: string;
let adminA: string;
let orgB: string;
let adminB: string;
const A1 = uuidv7();
const org = (id: string) => `/v1/organizations/${id}`;
const SECRET = 'whsec_' + 'x'.repeat(40);
const API_KEY = 'apikey-super-secret-value-123456';
let upstream: Server;
let upstreamUrl = '';
let upstreamFailures = 0;
let lastAuthorization = '';

type Instance = {
  id: string;
  status: string;
  version: number;
  webhook_path: string;
  has_credentials: boolean;
};

function signed(body: unknown, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-hos-timestamp': String(timestamp),
      'x-hos-signature': `sha256=${signature}`,
    },
  };
}

async function post(path: string, raw: string, headers: Record<string, string>) {
  const response = await fetch(`${h.baseUrl}${path}`, { method: 'POST', headers, body: raw });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  upstream = createServer((request, response) => {
    lastAuthorization = String(request.headers.authorization ?? '');
    if (upstreamFailures > 0) {
      upstreamFailures -= 1;
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  h = await startHarness(urls);
  ({ organizationId: orgA, adminToken: adminA } = await provisionTenant(h, [A1], 'p4-admin-a'));
  ({ organizationId: orgB, adminToken: adminB } = await provisionTenant(
    h,
    [uuidv7()],
    'p4-admin-b',
  ));
});
afterAll(async () => {
  await h.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function configureWebhook(
  orgId: string,
  adminToken: string,
  account: string | null,
  scope: 'organization' | 'property' = 'organization',
  propertyId: string | null = null,
): Promise<Instance> {
  const created = await call<Instance>(h, 'POST', `${org(orgId)}/connector-instances`, {
    token: adminToken,
    body: {
      connector_type: 'hos.signed_webhook',
      connector_version: 1,
      scope_level: scope,
      property_id: propertyId,
      display_name: 'Channel feed',
      credentials: { signing_secret: SECRET },
      provider_account_id: account,
    },
  });
  expect(created.status).toBe(201);
  const verified = await call<Instance>(
    h,
    'POST',
    `${org(orgId)}/connector-instances/${created.body.id}/health-check`,
    { token: adminToken },
  );
  expect(verified.body.status).toBe('verified');
  const activated = await call<Instance>(
    h,
    'POST',
    `${org(orgId)}/connector-instances/${created.body.id}/activate`,
    { token: adminToken, headers: { 'if-match': `"${verified.body.version}"` } },
  );
  expect(activated.status).toBe(200);
  return activated.body;
}

describe('Connector catalogue, lifecycle and credential security (P4)', () => {
  it('lists versioned connector contracts', async () => {
    const result = await call<{
      data: { type: string; version: number; credential_fields: string[] }[];
    }>(h, 'GET', `${org(orgA)}/connectors`, { token: adminA });
    expect(result.body.data.map((c) => `${c.type}@${c.version}`)).toEqual(
      expect.arrayContaining(['hos.signed_webhook@1', 'hos.http_endpoint@1']),
    );
  });

  it('credentials are never returned, stored in tenant tables, audited, logged or readable in the secret store file', async () => {
    const instance = await configureWebhook(orgA, adminA, 'acct-1');
    expect(instance.has_credentials).toBe(true);
    expect(JSON.stringify(instance)).not.toContain(SECRET);
    const listed = await call(h, 'GET', `${org(orgA)}/connector-instances`, { token: adminA });
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);
    const c = new pg.Client({ connectionString: urls.admin });
    await c.connect();
    try {
      for (const table of [
        'app.int_connector_instance',
        'app.int_connector_instance_history',
        'audit.audit_record',
        'eventing.outbox',
        'app.int_integration_log',
        'app.int_idempotency_key',
      ]) {
        const dump = await c.query(`SELECT * FROM ${table}`);
        expect(JSON.stringify(dump.rows), table).not.toContain(SECRET);
      }
    } finally {
      await c.end();
    }
    const dir = h.config.storage.localSecretsDir ?? '';
    for (const file of readdirSync(dir))
      expect(readFileSync(`${dir}/${file}`).toString('latin1')).not.toContain(SECRET);
  });

  it('activation is explicit and needs its own permission, separate from configure', async () => {
    const role = await call<{ id: string }>(h, 'POST', `${org(orgA)}/roles`, {
      token: adminA,
      body: {
        code: 'int_config',
        name: 'Integration configurer',
        permissions: ['integration:connector:configure', 'integration:connector:read'],
      },
    });
    const invited = await call<{ user: { id: string }; invitation: { token: string } }>(
      h,
      'POST',
      `${org(orgA)}/users`,
      { token: adminA, body: { display_name: 'configurer', realm: 'hotel_employee' } },
    );
    const configurer = await token(h.staff, 'p4-configurer');
    await call(h, 'POST', `${org(orgA)}/invitations/accept`, {
      token: configurer,
      body: { token: invited.body.invitation.token },
    });
    await call(h, 'POST', `${org(orgA)}/role-assignments`, {
      token: adminA,
      body: { user_id: invited.body.user.id, role_id: role.body.id },
    });
    const created = await call<Instance>(h, 'POST', `${org(orgA)}/connector-instances`, {
      token: configurer,
      body: {
        connector_type: 'hos.signed_webhook',
        connector_version: 1,
        scope_level: 'organization',
        display_name: 'X',
        credentials: { signing_secret: SECRET },
      },
    });
    expect(created.status).toBe(201);
    const verified = await call<Instance>(
      h,
      'POST',
      `${org(orgA)}/connector-instances/${created.body.id}/health-check`,
      { token: configurer },
    );
    expect(
      (
        await call(h, 'POST', `${org(orgA)}/connector-instances/${created.body.id}/activate`, {
          token: configurer,
          headers: { 'if-match': `"${verified.body.version}"` },
        })
      ).status,
    ).toBe(403);
    // Lifecycle order: an unverified instance can't be activated.
    const raw = await call<Instance>(h, 'POST', `${org(orgA)}/connector-instances`, {
      token: adminA,
      body: {
        connector_type: 'hos.signed_webhook',
        connector_version: 1,
        scope_level: 'organization',
        display_name: 'Y',
        credentials: { signing_secret: SECRET },
      },
    });
    const early = await call<{ code: string }>(
      h,
      'POST',
      `${org(orgA)}/connector-instances/${raw.body.id}/activate`,
      { token: adminA, headers: { 'if-match': '"1"' } },
    );
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('integration.invalid_transition');
  });

  it('health checks call the endpoint with retries, record logs, and mark failures', async () => {
    const created = await call<Instance>(h, 'POST', `${org(orgA)}/connector-instances`, {
      token: adminA,
      body: {
        connector_type: 'hos.http_endpoint',
        connector_version: 1,
        scope_level: 'property',
        property_id: A1,
        display_name: 'PMS bridge',
        settings: { base_url: upstreamUrl, health_path: '/health' },
        credentials: { api_key: API_KEY },
      },
    });
    expect(created.status).toBe(201);
    upstreamFailures = 1;
    const healthy = await call<Instance>(
      h,
      'POST',
      `${org(orgA)}/connector-instances/${created.body.id}/health-check`,
      { token: adminA },
    );
    expect(healthy.body.status).toBe('verified');
    expect(lastAuthorization).toBe(`Bearer ${API_KEY}`);
    const logs = await call<{ data: { outcome: string; status_code: number | null }[] }>(
      h,
      'GET',
      `${org(orgA)}/connector-instances/${created.body.id}/logs`,
      { token: adminA },
    );
    expect(logs.body.data.map((l) => l.outcome).sort()).toEqual(['retry', 'success']);
    expect(JSON.stringify(logs.body)).not.toContain(API_KEY);
    upstreamFailures = 10;
    const unhealthy = await call<Instance>(
      h,
      'POST',
      `${org(orgA)}/connector-instances/${created.body.id}/health-check`,
      { token: adminA },
    );
    expect(unhealthy.body.status).toBe('error');
    upstreamFailures = 0;
  });
});

describe('Inbound webhooks (CX-14; H-HOOK)', () => {
  it('H-HOOK-01 and 05: a valid signature stores one receipt under the instance tenant, duplicates once', async () => {
    const instance = await configureWebhook(orgA, adminA, 'acct-42');
    const event = {
      id: `evt_${uuidv7()}`,
      type: 'reservation.created',
      account_id: 'acct-42',
      data: { reference: 'R1' },
    };
    const first = signed(event);
    const one = await post(instance.webhook_path, first.raw, first.headers);
    expect(one.status).toBe(202);
    expect(one.body.duplicate).toBe(false);
    const again = signed(event);
    const two = await post(instance.webhook_path, again.raw, again.headers);
    expect(two.status).toBe(202);
    expect(two.body.duplicate).toBe(true);
    const c = new pg.Client({ connectionString: urls.admin });
    await c.connect();
    try {
      const receipts = await c.query<{ organization_id: string; raw: string }>(
        'SELECT organization_id, convert_from(raw_payload, $2) AS raw FROM app.int_webhook_receipt WHERE provider_event_id = $1',
        [event.id, 'UTF8'],
      );
      expect(receipts.rows.length).toBe(1);
      expect(receipts.rows[0]?.organization_id).toBe(orgA);
      expect(receipts.rows[0]?.raw).toBe(first.raw); // unchanged raw payload
      const events = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM eventing.outbox WHERE event_type = 'integration.webhook.received' AND payload->>'provider_event_id' = $1",
        [event.id],
      );
      expect(events.rows[0]?.n).toBe(1);
    } finally {
      await c.end();
    }
  });

  it('H-HOOK-02: an invalid or stale signature is rejected before anything is stored, and logged', async () => {
    const instance = await configureWebhook(orgA, adminA, null);
    const before = await lastSecuritySequence(urls.monitor);
    const event = { id: `evt_${uuidv7()}`, type: 'x.y' };
    const forged = signed(event, 'whsec_wrong_secret_' + 'y'.repeat(30));
    expect((await post(instance.webhook_path, forged.raw, forged.headers)).status).toBe(401);
    const stale = signed(event, SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect((await post(instance.webhook_path, stale.raw, stale.headers)).status).toBe(401);
    const c = new pg.Client({ connectionString: urls.admin });
    await c.connect();
    try {
      expect(
        (
          await c.query('SELECT 1 FROM app.int_webhook_receipt WHERE provider_event_id = $1', [
            event.id,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await c.end();
    }
    const events = await securityEvents(urls.monitor, before);
    expect(
      events.some((e) => e.outcome === 'authn_failed' && e.reason === 'signature_invalid'),
    ).toBe(true);
  });

  it('H-HOOK-03: a payload naming another account is rejected as context_mismatch', async () => {
    const instance = await configureWebhook(orgA, adminA, 'acct-own');
    const before = await lastSecuritySequence(urls.monitor);
    const body = signed({ id: `evt_${uuidv7()}`, type: 'x.y', account_id: 'acct-someone-else' });
    expect((await post(instance.webhook_path, body.raw, body.headers)).status).toBe(400);
    const events = await securityEvents(urls.monitor, before);
    expect(
      events.some(
        (e) => e.outcome === 'context_mismatch' && e.reason === 'webhook_account_mismatch',
      ),
    ).toBe(true);
  });

  it('H-HOOK-04: unknown endpoints, wrong providers and suspended instances answer 404, logged as tenant_unknown', async () => {
    const before = await lastSecuritySequence(urls.monitor);
    const body = signed({ id: 'evt_1', type: 'x.y' });
    expect(
      (await post(`/v1/webhooks/hos.signed_webhook/${'A'.repeat(43)}`, body.raw, body.headers))
        .status,
    ).toBe(404);
    const instance = await configureWebhook(orgB, adminB, null);
    expect(
      (
        await post(
          instance.webhook_path.replace('hos.signed_webhook', 'hos.http_endpoint'),
          body.raw,
          body.headers,
        )
      ).status,
    ).toBe(404);
    await call(h, 'POST', `${org(orgB)}/connector-instances/${instance.id}/suspend`, {
      token: adminB,
      headers: { 'if-match': `"${instance.version}"` },
    });
    expect((await post(instance.webhook_path, body.raw, body.headers)).status).toBe(404);
    const events = await securityEvents(urls.monitor, before);
    expect(
      events.filter((e) => e.reason === 'webhook_endpoint_unknown').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('another organization cannot read or operate an instance', async () => {
    const instance = await configureWebhook(orgA, adminA, null);
    expect(
      (await call(h, 'GET', `${org(orgA)}/connector-instances`, { token: adminB })).status,
    ).toBe(404);
    expect(
      (
        await call(h, 'POST', `${org(orgB)}/connector-instances/${instance.id}/health-check`, {
          token: adminB,
        })
      ).status,
    ).toBe(404);
  });
});
