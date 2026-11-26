import { readdirSync, readFileSync } from 'node:fs';
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
let adminA: string;
let orgB: string;
let adminB: string;
const A1 = uuidv7();
const org = (id: string) => `/v1/organizations/${id}`;
type Doc = {
  id: string;
  version: number;
  current_version: number;
  retention_until: string | null;
  status: string;
  document_class: string;
};

async function upload(
  tokenValue: string,
  path: string,
  version: number,
  content: string,
  type = 'text/plain',
) {
  const response = await fetch(`${h.baseUrl}${path}/content`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tokenValue}`,
      'content-type': type,
      'if-match': `"${version}"`,
    },
    body: content,
  });
  return { status: response.status, body: (await response.json()) as Doc };
}
async function download(tokenValue: string, path: string, query = '') {
  const response = await fetch(`${h.baseUrl}${path}/content${query}`, {
    headers: { authorization: `Bearer ${tokenValue}` },
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
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
  h = await startHarness(urls, { DOCUMENT_MAX_BYTES: '2048' });
  ({ organizationId: orgA, adminToken: adminA } = await provisionTenant(h, [A1], 'p5-admin-a'));
  ({ organizationId: orgB, adminToken: adminB } = await provisionTenant(
    h,
    [uuidv7()],
    'p5-admin-b',
  ));
  const provisioning = await token(h.machines, PROVISIONING_SUBJECT);
  await call(
    h,
    'PUT',
    `/v1/provisioning/organizations/${orgA}/properties/${A1}/configuration-snapshot`,
    {
      token: provisioning,
      body: {
        template_code: 'docs',
        template_version: 1,
        values: { 'documents.retention_days.identity': 30 },
        locked_keys: ['documents.retention_days.identity'],
      },
    },
  );
});
afterAll(async () => {
  await h.close();
});

describe('P5 documents: lifecycle, versions, encryption and access control', () => {
  it('uploads versions and streams them back unchanged; contents are encrypted at rest', async () => {
    const created = await call<Doc>(h, 'POST', `${org(orgA)}/documents`, {
      token: adminA,
      body: { document_class: 'general', title: 'House rules', scope_level: 'organization' },
    });
    expect(created.status).toBe(201);
    const path = `${org(orgA)}/documents/${created.body.id}`;
    const v1 = await upload(adminA, path, 1, 'Quiet hours start at 22:00.');
    expect(v1.status).toBe(200);
    expect(v1.body.current_version).toBe(1);
    const v2 = await upload(adminA, path, v1.body.version, 'Quiet hours start at 23:00.');
    expect(v2.body.current_version).toBe(2);
    const latest = await download(adminA, path);
    expect(latest.text).toBe('Quiet hours start at 23:00.');
    expect(latest.headers.get('content-disposition')).toBe('attachment');
    expect(latest.headers.get('cache-control')).toBe('no-store');
    expect((await download(adminA, path, '?version=1')).text).toBe('Quiet hours start at 22:00.');
    expect((await upload(adminA, path, 1, 'stale version')).status).toBe(409);
    const dir = h.config.storage.documentStorageDir ?? '';
    for (const file of readdirSync(dir))
      expect(readFileSync(`${dir}/${file}`).toString('latin1')).not.toContain('Quiet hours');
    const metadata = await call(h, 'GET', path, { token: adminA });
    expect(JSON.stringify(metadata.body)).not.toMatch(/storage_key/);
  });

  it('access is per class and scope; identity documents are audited on every read', async () => {
    const role = await call<{ id: string }>(h, 'POST', `${org(orgA)}/roles`, {
      token: adminA,
      body: {
        code: 'docs_general',
        name: 'General documents',
        permissions: ['document:general:read', 'document:general:write'],
      },
    });
    const invited = await call<{ user: { id: string }; invitation: { token: string } }>(
      h,
      'POST',
      `${org(orgA)}/users`,
      { token: adminA, body: { display_name: 'clerk', realm: 'hotel_employee' } },
    );
    const clerk = await token(h.staff, 'p5-clerk');
    await call(h, 'POST', `${org(orgA)}/invitations/accept`, {
      token: clerk,
      body: { token: invited.body.invitation.token },
    });
    await call(h, 'POST', `${org(orgA)}/role-assignments`, {
      token: adminA,
      body: { user_id: invited.body.user.id, role_id: role.body.id },
    });

    const idDoc = await call<Doc>(h, 'POST', `${org(orgA)}/documents`, {
      token: adminA,
      body: {
        document_class: 'identity',
        title: 'Guest passport',
        scope_level: 'property',
        property_id: A1,
      },
    });
    expect(idDoc.body.retention_until).not.toBeNull(); // from the P8 template setting (30 days)
    const path = `${org(orgA)}/documents/${idDoc.body.id}`;
    await upload(adminA, path, 1, 'PASSPORT-SCAN-BYTES', 'application/octet-stream');
    expect((await download(clerk, path)).status).toBe(403);
    expect(
      (
        await call(h, 'POST', `${org(orgA)}/documents`, {
          token: clerk,
          body: { document_class: 'identity', title: 'x', scope_level: 'organization' },
        })
      ).status,
    ).toBe(403);
    expect((await download(adminA, path)).status).toBe(200);
    expect((await download(adminA, path)).status).toBe(200);
    const reads = await admin((c) =>
      c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit.audit_record WHERE entity_id = $1 AND action = 'document.read'",
        [idDoc.body.id],
      ),
    );
    expect(reads.rows[0]?.n).toBe(2);
    // The clerk's search shows only classes they may read.
    const search = await call<{ data: Doc[] }>(h, 'GET', `${org(orgA)}/documents`, {
      token: clerk,
    });
    expect(search.body.data.every((d) => d.document_class === 'general')).toBe(true);
  });

  it('metadata search filters by class and title prefix with cursor pagination', async () => {
    for (const title of ['Contract Alpha', 'Contract Beta', 'Contract Gamma']) {
      await call(h, 'POST', `${org(orgA)}/documents`, {
        token: adminA,
        body: { document_class: 'contract', title, scope_level: 'organization' },
      });
    }
    const first = await call<{ data: { title: string }[]; page: { next_cursor: string } }>(
      h,
      'GET',
      `${org(orgA)}/documents?class=contract&title_prefix=Contract&limit=2`,
      { token: adminA },
    );
    expect(first.body.data.map((d) => d.title)).toEqual(['Contract Alpha', 'Contract Beta']);
    const second = await call<{ data: { title: string }[] }>(
      h,
      'GET',
      `${org(orgA)}/documents?class=contract&title_prefix=Contract&limit=2&cursor=${first.body.page.next_cursor}`,
      { token: adminA },
    );
    expect(second.body.data.map((d) => d.title)).toEqual(['Contract Gamma']);
  });

  it('documents of one organization are invisible to another', async () => {
    const created = await call<Doc>(h, 'POST', `${org(orgA)}/documents`, {
      token: adminA,
      body: { document_class: 'general', title: 'Private', scope_level: 'organization' },
    });
    expect(
      (await call(h, 'GET', `${org(orgB)}/documents/${created.body.id}`, { token: adminB })).status,
    ).toBe(404);
    expect(
      (await call(h, 'GET', `${org(orgA)}/documents/${created.body.id}`, { token: adminB })).status,
    ).toBe(404);
  });

  it('uploads beyond the configured size are refused', async () => {
    const created = await call<Doc>(h, 'POST', `${org(orgA)}/documents`, {
      token: adminA,
      body: { document_class: 'general', title: 'Big', scope_level: 'organization' },
    });
    expect(
      (await upload(adminA, `${org(orgA)}/documents/${created.body.id}`, 1, 'x'.repeat(5000)))
        .status,
    ).toBe(413);
  });

  it('deletion and retention remove contents, keep an audited tombstone, and stop downloads', async () => {
    const created = await call<Doc>(h, 'POST', `${org(orgA)}/documents`, {
      token: adminA,
      body: {
        document_class: 'identity',
        title: 'Expiring ID',
        scope_level: 'property',
        property_id: A1,
      },
    });
    const path = `${org(orgA)}/documents/${created.body.id}`;
    await upload(adminA, path, 1, 'ID-BYTES');
    // Test-only time travel. The capture trigger fails closed without a context, and history
    // requires a new version (E-19, E-20), so the shortcut sets both like any real writer must.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('hos.correlation_id', $1, true), set_config('hos.actor_id', $1, true), set_config('hos.organization_id', $2, true),
                set_config('hos.property_scope', 'all', true), set_config('hos.property_ids', '{}', true)`,
        [uuidv7(), orgA],
      );
      await c.query(
        "UPDATE app.doc_document SET retention_until = now() - interval '1 second', version = version + 1 WHERE id = $1",
        [created.body.id],
      );
      await c.query('COMMIT');
    });
    const worker = new WorkerRuntime(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: urls.api,
        WORKER_DATABASE_URL: urls.worker,
        RELAY_DATABASE_URL: urls.relay,
        SECLOG_DATABASE_URL: urls.seclog,
        HOS_CELL_ID: 'test-cell',
        LOG_LEVEL: 'error',
        HOS_DOCUMENT_STORAGE_DIR: h.config.storage.documentStorageDir ?? '',
        HOS_DOCUMENT_ENCRYPTION_KEY: h.config.storage.documentEncryptionKey ?? '',
      }),
    );
    try {
      expect(await worker.runDocumentRetention()).toBe(1);
    } finally {
      await worker.stop();
    }
    const after = await call<Doc>(h, 'GET', path, { token: adminA });
    expect(after.body.status).toBe('deleted');
    expect((await download(adminA, path)).status).toBe(404);
    const actions = await admin((c) =>
      c.query('SELECT action FROM audit.audit_record WHERE entity_id = $1 ORDER BY sequence', [
        created.body.id,
      ]),
    );
    expect(actions.rows.map((r: { action: string }) => r.action)).toContain(
      'document.retention_expired',
    );

    const manual = await call<Doc>(h, 'POST', `${org(orgA)}/documents`, {
      token: adminA,
      body: { document_class: 'general', title: 'Delete me', scope_level: 'organization' },
    });
    const deleted = await call<Doc>(h, 'DELETE', `${org(orgA)}/documents/${manual.body.id}`, {
      token: adminA,
      headers: { 'if-match': '"1"' },
    });
    expect(deleted.body.status).toBe('deleted');
  });
});
