import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../../src/config/app-config.js';
import { uuidv7 } from '../../src/kernel/ids.js';
import { WorkerRuntime } from '../../src/platform/worker/worker-runtime.js';
import {
  call,
  PROVISIONING_SUBJECT,
  provisionTenant,
  startHarness,
  token,
  type Harness,
} from '../support/http-harness.js';

const urls = inject('hosDb');
let h: Harness;
let orgA: string;
let orgB: string;
let adminA: string;
let adminB: string;
const A1 = uuidv7();
const A2 = uuidv7();
const B1 = uuidv7();
const org = (id: string) => `/v1/organizations/${id}`;
type Config = {
  configuration_version: string | null;
  template: { code: string } | null;
  settings: Record<string, { value: unknown; source: string; locked: boolean }>;
};

beforeAll(async () => {
  h = await startHarness(urls);
  ({ organizationId: orgA, adminToken: adminA } = await provisionTenant(h, [A1, A2], 'p8-admin-a'));
  ({ organizationId: orgB, adminToken: adminB } = await provisionTenant(h, [B1], 'p8-admin-b'));
  const provisioning = await token(h.machines, PROVISIONING_SUBJECT);
  for (const [o, p] of [
    [orgA, A1],
    [orgA, A2],
    [orgB, B1],
  ] as const) {
    const snapshot = await call(
      h,
      'PUT',
      `/v1/provisioning/organizations/${o}/properties/${p}/configuration-snapshot`,
      {
        token: provisioning,
        body: {
          template_code: 'in-standard',
          template_version: 1,
          values: {
            'localization.time_zone': 'Asia/Kolkata',
            'localization.default_language': 'hi',
            'localization.currency': 'INR',
            'documents.retention_days.identity': 365,
          },
          locked_keys: ['localization.time_zone'],
        },
      },
    );
    expect(snapshot.status).toBe(200);
  }
});
afterAll(async () => {
  await h.close();
});

describe('P8 configuration inheritance, override rules and isolation', () => {
  it('a property resolves template values; the platform default fills the rest', async () => {
    const result = await call<Config>(h, 'GET', `${org(orgA)}/properties/${A1}/configuration`, {
      token: adminA,
    });
    expect(result.status).toBe(200);
    expect(result.body.template?.code).toBe('in-standard');
    expect(result.body.settings['localization.time_zone']).toMatchObject({
      value: 'Asia/Kolkata',
      source: 'template',
      locked: true,
    });
    expect(result.body.settings['features.workflow_triggers']).toMatchObject({
      value: true,
      source: 'default',
    });
  });

  it('organization overrides apply to every property; property overrides to one property', async () => {
    const orgChange = await call(
      h,
      'PUT',
      `${org(orgA)}/configuration/localization.default_language`,
      { token: adminA, body: { value: 'en-GB', reason: 'Group standard' } },
    );
    expect(orgChange.status).toBe(200);
    const propertyChange = await call(
      h,
      'PUT',
      `${org(orgA)}/properties/${A1}/configuration/localization.default_language`,
      { token: adminA, body: { value: 'ta', reason: 'Local guests' } },
    );
    expect(propertyChange.status).toBe(200);
    const a1 = await call<Config>(h, 'GET', `${org(orgA)}/properties/${A1}/configuration`, {
      token: adminA,
    });
    const a2 = await call<Config>(h, 'GET', `${org(orgA)}/properties/${A2}/configuration`, {
      token: adminA,
    });
    expect(a1.body.settings['localization.default_language']).toMatchObject({
      value: 'ta',
      source: 'property',
    });
    expect(a2.body.settings['localization.default_language']).toMatchObject({
      value: 'en-GB',
      source: 'organization',
    });
  });

  it("one organization's settings never reach another organization", async () => {
    const b1 = await call<Config>(h, 'GET', `${org(orgB)}/properties/${B1}/configuration`, {
      token: adminB,
    });
    expect(b1.body.settings['localization.default_language']).toMatchObject({
      value: 'hi',
      source: 'template',
    });
    expect(
      (await call(h, 'GET', `${org(orgB)}/properties/${B1}/configuration`, { token: adminA }))
        .status,
    ).toBe(404);
    expect((await call(h, 'GET', `${org(orgB)}/configuration`, { token: adminA })).status).toBe(
      404,
    );
  });

  it('explicit override rules: unknown keys, wrong levels and invalid values are rejected', async () => {
    expect(
      (
        await call(h, 'PUT', `${org(orgA)}/configuration/made.up_key`, {
          token: adminA,
          body: { value: 1, reason: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, 'PUT', `${org(orgA)}/configuration/documents.retention_days.identity`, {
          token: adminA,
          body: { value: 30, reason: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, 'PUT', `${org(orgA)}/properties/${A1}/configuration/localization.currency`, {
          token: adminA,
          body: { value: 'rupees', reason: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, 'PUT', `${org(orgA)}/configuration/localization.default_language`, {
          token: adminA,
          body: { value: 'en', reason: '' },
        })
      ).status,
    ).toBe(400);
  });

  it('a key locked by the template cannot be overridden at the property', async () => {
    const locked = await call<{ code: string }>(
      h,
      'PUT',
      `${org(orgA)}/properties/${A1}/configuration/localization.time_zone`,
      { token: adminA, body: { value: 'Europe/London', reason: 'x' } },
    );
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('config.setting_locked_by_template');
  });

  it('effective-dated changes apply from their date; history records every value with its reason', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    expect(
      (
        await call(h, 'PUT', `${org(orgA)}/properties/${A1}/configuration/localization.currency`, {
          token: adminA,
          body: { value: 'USD', reason: 'From tomorrow', effective_from: future },
        })
      ).status,
    ).toBe(200);
    const now = await call<Config>(h, 'GET', `${org(orgA)}/properties/${A1}/configuration`, {
      token: adminA,
    });
    expect(now.body.settings['localization.currency']).toMatchObject({
      value: 'INR',
      source: 'template',
    });
    const history = await call<{ data: { reason: string; setting_value: unknown }[] }>(
      h,
      'GET',
      `${org(orgA)}/properties/${A1}/configuration/localization.currency/history`,
      { token: adminA },
    );
    expect(history.body.data.map((row) => row.reason)).toContain('From tomorrow');
  });

  it('organization overrides are versioned: a stale If-Match is a conflict', async () => {
    const stale = await call(h, 'PUT', `${org(orgA)}/configuration/localization.default_language`, {
      token: adminA,
      body: { value: 'fr', reason: 'x' },
      headers: { 'if-match': '"99"' },
    });
    expect(stale.status).toBe(409);
    const ok = await call<Config>(
      h,
      'PUT',
      `${org(orgA)}/configuration/localization.default_language`,
      { token: adminA, body: { value: 'fr', reason: 'Updated' }, headers: { 'if-match': '"1"' } },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.settings['localization.default_language']?.value).toBe('fr');
  });

  it('changes bump the property configuration version used for date provenance (E-43)', async () => {
    const before = await call<Config>(h, 'GET', `${org(orgA)}/properties/${A2}/configuration`, {
      token: adminA,
    });
    await call(h, 'PUT', `${org(orgA)}/properties/${A2}/configuration/branding.display_name`, {
      token: adminA,
      body: { value: 'A2 Beach', reason: 'Rebrand' },
    });
    const after = await call<Config>(h, 'GET', `${org(orgA)}/properties/${A2}/configuration`, {
      token: adminA,
    });
    expect(after.body.configuration_version).not.toBe(before.body.configuration_version);
    expect(after.body.settings['branding.display_name']).toMatchObject({
      value: 'A2 Beach',
      source: 'property',
    });
  });

  it('the P8 consumer initializes configuration state when a property is provisioned', async () => {
    const worker = new WorkerRuntime(
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
    try {
      const newProperty = uuidv7();
      const provisioning = await token(h.machines, PROVISIONING_SUBJECT);
      expect(
        (
          await call(h, 'PUT', `/v1/provisioning/organizations/${orgB}/properties/${newProperty}`, {
            token: provisioning,
            body: { display_name: 'New' },
          })
        ).status,
      ).toBe(201);
      for (let i = 0; i < 3; i += 1) await worker.tick();
      const client = new pg.Client({ connectionString: urls.admin });
      await client.connect();
      try {
        const state = await client.query<{ status: string }>(
          'SELECT status FROM app.cfg_property_state WHERE organization_id = $1 AND property_id = $2',
          [orgB, newProperty],
        );
        expect(state.rows[0]?.status).toBe('pending');
      } finally {
        await client.end();
      }
    } finally {
      await worker.stop();
    }
  });
});
