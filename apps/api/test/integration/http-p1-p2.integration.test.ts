import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { verifyAuditChain } from '../../src/kernel/audit/audit-writer.js';
import { verifySecurityChain } from '../../src/kernel/audit/security-event-writer.js';
import { uuidv7 } from '../../src/kernel/ids.js';
import {
  call,
  lastSecuritySequence,
  PROVISIONING_SUBJECT,
  provisionTenant,
  securityEvents,
  startHarness,
  token,
  type Harness,
} from '../support/http-harness.js';

const urls = inject('hosDb');
let h: Harness;
const A1 = uuidv7();
const A2 = uuidv7();
const B1 = uuidv7();
let orgA: string;
let orgB: string;
let adminA: string;
let adminB: string;

const org = (id: string) => `/v1/organizations/${id}`;
const prop = (o: string, p: string) => `${org(o)}/properties/${p}`;

beforeAll(async () => {
  h = await startHarness(urls);
  ({ organizationId: orgA, adminToken: adminA } = await provisionTenant(h, [A1, A2], 'admin-a'));
  ({ organizationId: orgB, adminToken: adminB } = await provisionTenant(h, [B1], 'admin-b'));
});
afterAll(async () => {
  await h.close();
});

describe('Provisioning identity (H-PROV)', () => {
  it('H-PROV-01 and 02: creates with the Control Plane IDs, and the same command is idempotent', async () => {
    const provisioning = await token(h.machines, PROVISIONING_SUBJECT);
    const again = await call(
      h,
      'PUT',
      prop(orgA, A1).replace('/v1/organizations', '/v1/provisioning/organizations'),
      {
        token: provisioning,
        body: { display_name: `Property ${A1.slice(-6)}` },
      },
    );
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: A1, organization_id: orgA, version: 1 });
    const orgAgain = await call<{
      first_administrator_invitation: unknown;
      organization: { id: string };
    }>(h, 'PUT', `/v1/provisioning/organizations/${orgA}`, {
      token: provisioning,
      body: {
        display_name: `Org ${orgA.slice(-6)}`,
        first_administrator: { display_name: 'First Admin' },
      },
    });
    expect(orgAgain.status).toBe(200);
    expect(orgAgain.body.organization.id).toBe(orgA);
    expect(orgAgain.body.first_administrator_invitation).toBeNull(); // no second administrator invitation
  });

  it('H-PROV-03: the provisioning identity is denied every other route and recorded', async () => {
    const before = await lastSecuritySequence(urls.monitor);
    const provisioning = await token(h.machines, PROVISIONING_SUBJECT);
    const result = await call(h, 'GET', `${prop(orgA, A1)}/departments`, { token: provisioning });
    expect(result.status).toBe(404);
    const events = await securityEvents(urls.monitor, before);
    expect(
      events.some((e) => e.outcome === 'authz_denied' && e.reason === 'provisioning_scope_only'),
    ).toBe(true);
  });

  it('H-PROV-04: any other identity is denied the provisioning route', async () => {
    const result = await call(h, 'PUT', `/v1/provisioning/organizations/${orgA}`, {
      token: adminA,
      body: { display_name: 'x', first_administrator: { display_name: 'x' } },
    });
    expect(result.status).toBe(404);
    const machine = await call(h, 'PUT', `/v1/provisioning/organizations/${uuidv7()}`, {
      token: await token(h.machines, 'some-other-client'),
      body: { display_name: 'x', first_administrator: { display_name: 'x' } },
    });
    expect(machine.status).toBe(404);
  });
});

describe('Authentication and forged context (H-CTX, CX-04 to CX-09)', () => {
  it('401 for a missing, malformed, wrong-audience, expired or unknown-issuer credential, each recorded', async () => {
    const before = await lastSecuritySequence(urls.monitor);
    const path = `${org(orgA)}/users`;
    expect((await call(h, 'GET', path)).status).toBe(401);
    expect(
      (await call(h, 'GET', path, { headers: { authorization: 'Bearer not.a.jwt!' } })).status,
    ).toBe(401);
    expect(
      (
        await call(h, 'GET', path, {
          token: await token(h.staff, 'admin-a', { audience: 'another-service' }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(h, 'GET', path, {
          token: await token(h.staff, 'admin-a', {
            expiresIn: '-1m',
            issuedAt: Math.floor(Date.now() / 1000) - 600,
          }),
        })
      ).status,
    ).toBe(401);
    const stranger = { ...h.staff, issuer: 'https://evil.example' };
    expect((await call(h, 'GET', path, { token: await token(stranger, 'admin-a') })).status).toBe(
      401,
    );
    await new Promise((r) => setTimeout(r, 400)); // aggregation window flush
    const events = await securityEvents(urls.monitor, before);
    const reasons = new Set(
      events.filter((e) => e.outcome === 'authn_failed').map((e) => e.reason),
    );
    for (const reason of [
      'credential_missing',
      'credential_malformed',
      'audience_invalid',
      'token_expired',
      'issuer_unknown',
    ]) {
      expect(reasons.has(reason), reason).toBe(true);
    }
    // No credential, token, header or body ever appears in the log (map §7.2).
    expect(JSON.stringify(events)).not.toMatch(/Bearer|eyJ/);
  });

  it('H-CTX-04 and H-CTX-05: another organization and an unknown organization give the same 404', async () => {
    const before = await lastSecuritySequence(urls.monitor);
    const other = await call(h, 'GET', `${org(orgB)}/users`, { token: adminA });
    const unknown = await call(h, 'GET', `${org(uuidv7())}/users`, { token: adminA });
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });
    expect(strip(other.body)).toEqual(strip(unknown.body));
    const events = await securityEvents(urls.monitor, before);
    expect(
      events.find((e) => e.tenant_status === 'verified_not_authorized')?.target_tenant_id,
    ).toBe(orgB);
    expect(
      events.some(
        (e) =>
          e.outcome === 'tenant_unknown' &&
          e.tenant_status === 'unknown' &&
          e.target_tenant_id === null,
      ),
    ).toBe(true);
  });

  it('H-CTX-06: a body carrying organization_id or property_id is rejected as an unknown field', async () => {
    const result = await call<{ code: string; errors: { message: string }[] }>(
      h,
      'POST',
      `${prop(orgA, A1)}/departments`,
      {
        token: adminA,
        body: { code: 'FO', name: 'Front office', organization_id: orgB },
      },
    );
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('validation_failed');
    expect(result.body.errors[0]?.message).toMatch(/organization_id/);
  });

  it('H-CTX-08 and H-CTX-09: token claims and headers naming tenants, roles or actors are ignored', async () => {
    const forged = await token(h.staff, 'admin-a', {
      claims: {
        organization_id: orgB,
        roles: ['organization_administrator'],
        permissions: ['iam:user:read'],
      },
    });
    expect((await call(h, 'GET', `${org(orgB)}/users`, { token: forged })).status).toBe(404);
    const headers = { 'X-Organization-Id': orgB, 'X-Actor-Id': uuidv7() };
    const own = await call<{ data: unknown[] }>(h, 'GET', `${org(orgA)}/users`, {
      token: adminA,
      headers,
    });
    expect(own.status).toBe(200);
    expect((await call(h, 'GET', `${org(orgB)}/users`, { token: adminA, headers })).status).toBe(
      404,
    );
  });

  it('responses carry security headers and no framework header', async () => {
    const result = await call(h, 'GET', `${org(orgA)}`, { token: adminA });
    expect(result.status).toBe(200);
    expect(result.headers.get('x-powered-by')).toBeNull();
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Departments, idempotency and versioning (P1; F-06 to F-22; E-19)', () => {
  it('creates a department idempotently: replay, reuse and missing key', async () => {
    const key = uuidv7();
    const body = { code: 'HK', name: 'Housekeeping' };
    const first = await call<{ id: string; version: number }>(
      h,
      'POST',
      `${prop(orgA, A1)}/departments`,
      { token: adminA, body, idempotencyKey: key },
    );
    expect(first.status).toBe(201);
    expect(first.headers.get('etag')).toBe('"1"');
    const replay = await call<{ id: string }>(h, 'POST', `${prop(orgA, A1)}/departments`, {
      token: adminA,
      body: { name: 'Housekeeping', code: 'HK' },
      idempotencyKey: key,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const reuse = await call<{ code: string }>(h, 'POST', `${prop(orgA, A1)}/departments`, {
      token: adminA,
      body: { code: 'MT', name: 'Maintenance' },
      idempotencyKey: key,
    });
    expect(reuse.status).toBe(422);
    expect(reuse.body.code).toBe('idempotency_key_reuse');
    expect(
      (
        await call(h, 'POST', `${prop(orgA, A1)}/departments`, {
          token: adminA,
          body,
          idempotencyKey: null,
        })
      ).status,
    ).toBe(400);
    // H-IDEM-08: the same key in another organization is independent.
    const otherOrg = await call(h, 'POST', `${prop(orgB, B1)}/departments`, {
      token: adminB,
      body,
      idempotencyKey: key,
    });
    expect(otherOrg.status).toBe(201);
    expect(otherOrg.headers.get('idempotent-replayed')).toBeNull();
  });

  it('updates require If-Match; a stale version is a conflict', async () => {
    const created = await call<{ id: string }>(h, 'POST', `${prop(orgA, A1)}/departments`, {
      token: adminA,
      body: { code: 'FB', name: 'Food' },
    });
    const path = `${prop(orgA, A1)}/departments/${created.body.id}`;
    expect((await call(h, 'PATCH', path, { token: adminA, body: { name: 'F&B' } })).status).toBe(
      428,
    );
    const ok = await call<{ version: number }>(h, 'PATCH', path, {
      token: adminA,
      body: { name: 'F&B' },
      headers: { 'if-match': '"1"' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await call<{ code: string }>(h, 'PATCH', path, {
      token: adminA,
      body: { name: 'Again' },
      headers: { 'if-match': '"1"' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('lists departments with cursor pagination and a total order', async () => {
    for (const code of ['P1', 'P2', 'P3']) {
      await call(h, 'POST', `${prop(orgA, A2)}/departments`, {
        token: adminA,
        body: { code, name: code },
      });
    }
    const first = await call<{
      data: { code: string }[];
      page: { next_cursor: string; has_more: boolean };
    }>(h, 'GET', `${prop(orgA, A2)}/departments?limit=2`, { token: adminA });
    expect(first.body.data.map((d) => d.code)).toEqual(['P1', 'P2']);
    expect(first.body.page.has_more).toBe(true);
    const second = await call<{ data: { code: string }[] }>(
      h,
      'GET',
      `${prop(orgA, A2)}/departments?limit=2&cursor=${first.body.page.next_cursor}`,
      { token: adminA },
    );
    expect(second.body.data.map((d) => d.code)).toEqual(['P3']);
    // A cursor from another listing is rejected (F-12).
    expect(
      (
        await call(
          h,
          'GET',
          `${prop(orgA, A1)}/departments?cursor=${first.body.page.next_cursor}`,
          { token: adminA },
        )
      ).status,
    ).toBe(400);
  });
});

describe('Role-based access at organization, property and department scope (P2; H-PROP; CX-07)', () => {
  let hkDepartment: string;
  let propertyUser: string;
  let departmentUser: string;

  beforeAll(async () => {
    const departments = await call<{ data: { id: string; code: string }[] }>(
      h,
      'GET',
      `${prop(orgA, A1)}/departments`,
      { token: adminA },
    );
    hkDepartment = departments.body.data.find((d) => d.code === 'HK')?.id ?? '';
    const role = await call<{ id: string }>(h, 'POST', `${org(orgA)}/roles`, {
      token: adminA,
      body: {
        code: 'dept_reader',
        name: 'Department reader',
        permissions: ['tenant:property:read', 'tenant:department:read', 'tenant:department:manage'],
      },
    });
    expect(role.status).toBe(201);
    const invite = async (
      subject: string,
      scopeProperty: string | null,
      scopeDepartment: string | null,
    ) => {
      const invited = await call<{ user: { id: string }; invitation: { token: string } }>(
        h,
        'POST',
        `${org(orgA)}/users`,
        {
          token: adminA,
          body: { display_name: subject, realm: 'hotel_employee' },
        },
      );
      expect(invited.status).toBe(201);
      const userToken = await token(h.staff, subject);
      expect(
        (
          await call(h, 'POST', `${org(orgA)}/invitations/accept`, {
            token: userToken,
            body: { token: invited.body.invitation.token },
          })
        ).status,
      ).toBe(201);
      const assigned = await call(h, 'POST', `${org(orgA)}/role-assignments`, {
        token: adminA,
        body: {
          user_id: invited.body.user.id,
          role_id: role.body.id,
          scope_property_id: scopeProperty,
          scope_department_id: scopeDepartment,
        },
      });
      expect(assigned.status).toBe(201);
      return userToken;
    };
    propertyUser = await invite('property-user', A1, null);
    departmentUser = await invite('department-user', A1, hkDepartment);
  });

  it('H-PROP-01: a role on A1 only gives 404 on A2, recorded as authz_denied for a verified tenant', async () => {
    expect(
      (await call(h, 'GET', `${prop(orgA, A1)}/departments`, { token: propertyUser })).status,
    ).toBe(200);
    const before = await lastSecuritySequence(urls.monitor);
    expect(
      (await call(h, 'GET', `${prop(orgA, A2)}/departments`, { token: propertyUser })).status,
    ).toBe(404);
    const events = await securityEvents(urls.monitor, before);
    expect(
      events.some(
        (e) =>
          e.outcome === 'authz_denied' &&
          e.tenant_status === 'verified_not_authorized' &&
          e.target_tenant_id === orgA &&
          e.actor_id !== null,
      ),
    ).toBe(true);
  });

  it('H-PROP-02: an organization-level list under a property-only role covers only A1', async () => {
    const result = await call<{ data: { id: string }[] }>(h, 'GET', `${org(orgA)}/properties`, {
      token: propertyUser,
    });
    expect(result.status).toBe(200);
    expect(result.body.data.map((p) => p.id)).toEqual([A1]);
    const admin = await call<{ data: { id: string }[] }>(h, 'GET', `${org(orgA)}/properties`, {
      token: adminA,
    });
    expect(new Set(admin.body.data.map((p) => p.id))).toEqual(new Set([A1, A2])); // H-PROP-04
  });

  it('a department-scoped assignment does not grant property-level management: 403, audited', async () => {
    const created = await call(h, 'POST', `${prop(orgA, A1)}/departments`, {
      token: departmentUser,
      body: { code: 'XX', name: 'Denied' },
    });
    expect(created.status).toBe(403);
    const byProperty = await call(h, 'POST', `${prop(orgA, A1)}/departments`, {
      token: propertyUser,
      body: { code: 'YY', name: 'Allowed' },
    });
    expect(byProperty.status).toBe(201);
  });

  it('organization-level administration needs an organization-wide role', async () => {
    expect((await call(h, 'GET', `${org(orgA)}/users`, { token: propertyUser })).status).toBe(403);
  });

  it('roles may contain only registered, assignable permissions', async () => {
    const bad = await call(h, 'POST', `${org(orgA)}/roles`, {
      token: adminA,
      body: { code: 'bad', name: 'Bad', permissions: ['tenant:provision'] },
    });
    expect(bad.status).toBe(400);
    const unknown = await call(h, 'POST', `${org(orgA)}/roles`, {
      token: adminA,
      body: { code: 'bad2', name: 'Bad', permissions: ['made:up:permission'] },
    });
    expect(unknown.status).toBe(400);
  });

  it("H-FK-04 through the API: an assignment scoped to another organization's property is refused", async () => {
    const users = await call<{ data: { id: string; display_name: string }[] }>(
      h,
      'GET',
      `${org(orgA)}/users`,
      { token: adminA },
    );
    const roles = await call<{ data: { id: string; code: string }[] }>(
      h,
      'GET',
      `${org(orgA)}/roles`,
      { token: adminA },
    );
    const result = await call(h, 'POST', `${org(orgA)}/role-assignments`, {
      token: adminA,
      body: {
        user_id: users.body.data[0]?.id,
        role_id: roles.body.data[0]?.id,
        scope_property_id: B1,
        scope_department_id: null,
      },
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: 'validation_failed',
      detail: 'A referenced resource does not exist.',
    });
  });

  it('revoking sessions refuses tokens issued before the revocation', async () => {
    const users = await call<{ data: { id: string; display_name: string; version: number }[] }>(
      h,
      'GET',
      `${org(orgA)}/users`,
      { token: adminA },
    );
    const target = users.body.data.find((u) => u.display_name === 'property-user');
    const oldToken = await token(h.staff, 'property-user', {
      issuedAt: Math.floor(Date.now() / 1000) - 5,
    });
    expect(
      (await call(h, 'POST', `${org(orgA)}/users/${target?.id}/sessions/revoke`, { token: adminA }))
        .status,
    ).toBe(204);
    expect(
      (await call(h, 'GET', `${prop(orgA, A1)}/departments`, { token: oldToken })).status,
    ).toBe(401);
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = await token(h.staff, 'property-user');
    expect((await call(h, 'GET', `${prop(orgA, A1)}/departments`, { token: fresh })).status).toBe(
      200,
    );
  });
});

describe('Audit and outbox integration (G4, G5; map §1.1)', () => {
  it('every change is audited in a verifiable chain, and events are in the outbox', async () => {
    const client = new pg.Client({ connectionString: urls.monitor });
    await client.connect();
    try {
      for (const organizationId of [orgA, orgB]) {
        const chain = await verifyAuditChain(client, organizationId);
        expect(chain.valid, organizationId).toBe(true);
        expect(chain.records).toBeGreaterThan(3);
      }
      const actions = (
        await client.query<{ action: string }>(
          'SELECT DISTINCT action FROM audit.audit_record WHERE organization_id = $1',
          [orgA],
        )
      ).rows.map((r) => r.action);
      for (const action of [
        'tenant.organization.provisioned',
        'tenant.property.provisioned',
        'tenant.department.created',
        'tenant.department.updated',
        'iam.role.created',
        'iam.user.invited',
        'iam.invitation.accepted',
        'iam.role_assignment.created',
        'iam.authorization.denied',
        'iam.user.sessions_revoked',
      ]) {
        expect(actions, action).toContain(action);
      }
      // Personal values are redacted (map §1.1): display names never appear in clear.
      const payloads = (
        await client.query<{ payload: unknown }>(
          "SELECT payload FROM audit.audit_record WHERE action = 'iam.user.invited'",
        )
      ).rows;
      expect(JSON.stringify(payloads)).not.toMatch(/property-user|department-user|First Admin/);
      expect(JSON.stringify(payloads)).toMatch(/"redacted":true/);
      const security = await verifySecurityChain(client);
      expect(security.valid).toBe(true);
      expect(security.records).toBeGreaterThan(5);
    } finally {
      await client.end();
    }
    const relay = new pg.Client({ connectionString: urls.relay });
    await relay.connect();
    try {
      const types = (
        await relay.query<{ event_type: string }>(
          'SELECT DISTINCT event_type FROM eventing.outbox WHERE organization_id = $1',
          [orgA],
        )
      ).rows.map((r) => r.event_type);
      for (const type of [
        'tenant.organization.provisioned',
        'tenant.property.provisioned',
        'tenant.department.created',
        'iam.user.created',
        'iam.role_assignment.changed',
      ]) {
        expect(types, type).toContain(type);
      }
    } finally {
      await relay.end();
    }
  });
});

describe('One-time secrets are never stored for idempotent replay (E-26)', () => {
  it('an invitation token is returned once; the stored replay omits it', async () => {
    const key = uuidv7();
    const body = { display_name: 'Replay Check', realm: 'hotel_employee' };
    const first = await call<{ invitation: { token: string | null } }>(
      h,
      'POST',
      `${org(orgA)}/users`,
      { token: adminA, body, idempotencyKey: key },
    );
    expect(first.status).toBe(201);
    const issued = first.body.invitation.token ?? '';
    expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const replay = await call<{ invitation: { token: string | null; delivered: boolean } }>(
      h,
      'POST',
      `${org(orgA)}/users`,
      { token: adminA, body, idempotencyKey: key },
    );
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.invitation).toMatchObject({ token: null, delivered: true });
    const adminClient = new pg.Client({ connectionString: urls.admin });
    await adminClient.connect();
    try {
      const stored = await adminClient.query<{ body: unknown }>(
        'SELECT response_body AS body FROM app.iam_idempotency_key WHERE idempotency_key = $1',
        [key],
      );
      expect(stored.rows.length).toBe(1);
      expect(JSON.stringify(stored.rows[0]?.body)).not.toContain(issued);
    } finally {
      await adminClient.end();
    }
  });
});
