import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PrincipalGrants } from '../../src/modules/iam/public/grants.js';
import {
  CircuitBreaker,
  OutboundHttp,
  SIGNED_WEBHOOK,
} from '../../src/modules/integration/public/index.js';
import { LocalEncryptedSecretStore } from '../../src/modules/integration/secret-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const P1 = '0a100000-0000-7000-8000-000000000001';
const P2 = '0a100000-0000-7000-8000-000000000002';
const HK = 'd0a10000-0000-7000-8000-000000000001';
const MT = 'd0a10000-0000-7000-8000-000000000002';

describe('permission evaluation (CX-07, A-11, A-12, H-DEPT-01/02)', () => {
  const grants = (list: { p: string[]; property: string | null; department: string | null }[]) =>
    new PrincipalGrants(
      'org',
      'actor',
      list.map((g) => ({
        permissions: new Set(g.p),
        propertyId: g.property,
        departmentId: g.department,
      })),
    );

  it('organization-wide grants cover everything; property grants one property; department grants one department', () => {
    const org = grants([{ p: ['x:y'], property: null, department: null }]);
    expect(org.allows('x:y')).toBe(true);
    expect(org.allows('x:y', { propertyId: P2, departmentId: MT })).toBe(true);
    expect(org.propertyScope()).toEqual({ kind: 'all_in_organization' });

    const property = grants([{ p: ['x:y'], property: P1, department: null }]);
    expect(property.allows('x:y')).toBe(false); // organization-level checks need an organization-wide grant
    expect(property.allows('x:y', { propertyId: P1, departmentId: HK })).toBe(true);
    expect(property.allows('x:y', { propertyId: P2 })).toBe(false);
    expect(property.propertyScope()).toEqual({ kind: 'listed', propertyIds: [P1] });

    const department = grants([{ p: ['task:complete'], property: P1, department: HK }]);
    expect(department.allows('task:complete', { propertyId: P1, departmentId: HK })).toBe(true); // H-DEPT-01
    expect(department.allows('task:complete', { propertyId: P1, departmentId: MT })).toBe(false); // H-DEPT-02
    expect(department.allows('task:complete', { propertyId: P1 })).toBe(false);
    expect(department.allows('other:perm', { propertyId: P1, departmentId: HK })).toBe(false);
  });

  it('reassignment needs the permission in both departments (CX-18, H-DEPT-08)', () => {
    const onlyHk = grants([{ p: ['task:reassign'], property: P1, department: HK }]);
    const both = grants([
      { p: ['task:reassign'], property: P1, department: HK },
      { p: ['task:reassign'], property: P1, department: MT },
    ]);
    const canReassign = (g: PrincipalGrants) =>
      g.allows('task:reassign', { propertyId: P1, departmentId: HK }) &&
      g.allows('task:reassign', { propertyId: P1, departmentId: MT });
    expect(canReassign(onlyHk)).toBe(false);
    expect(canReassign(both)).toBe(true);
  });
});

describe('signed webhook connector', () => {
  const secret = 's'.repeat(40);
  const sign = (raw: string, ts: number, key = secret) =>
    `sha256=${createHmac('sha256', key).update(`${ts}.${raw}`).digest('hex')}`;
  const now = 1_800_000_000;

  it('verifies HMAC signatures in constant time within the replay window', () => {
    const raw = '{"id":"e1","type":"a.b"}';
    const webhook = SIGNED_WEBHOOK.webhook;
    expect(
      webhook?.verifySignature(
        Buffer.from(raw),
        { 'x-hos-timestamp': String(now), 'x-hos-signature': sign(raw, now) },
        { signing_secret: secret },
        now,
      ),
    ).toBe(true);
    expect(
      webhook?.verifySignature(
        Buffer.from(raw),
        { 'x-hos-timestamp': String(now), 'x-hos-signature': sign(raw, now, 'x'.repeat(40)) },
        { signing_secret: secret },
        now,
      ),
    ).toBe(false);
    expect(
      webhook?.verifySignature(
        Buffer.from(`${raw} `),
        { 'x-hos-timestamp': String(now), 'x-hos-signature': sign(raw, now) },
        { signing_secret: secret },
        now,
      ),
    ).toBe(false);
    expect(
      webhook?.verifySignature(
        Buffer.from(raw),
        { 'x-hos-timestamp': String(now - 600), 'x-hos-signature': sign(raw, now - 600) },
        { signing_secret: secret },
        now,
      ),
    ).toBe(false);
    expect(webhook?.parse(Buffer.from('not json'))).toBeNull();
  });
});

describe('outbound resilience', () => {
  it('the circuit breaker opens after repeated failures and closes after the cooldown', () => {
    let clock = 0;
    const breaker = new CircuitBreaker(2, 1000, () => clock);
    breaker.failure();
    expect(breaker.open).toBe(false);
    breaker.failure();
    expect(breaker.open).toBe(true);
    clock = 1001;
    expect(breaker.open).toBe(false);
  });

  it('an open circuit refuses calls without contacting the endpoint', async () => {
    const http = new OutboundHttp({ breakerThreshold: 1, maxAttempts: 1 });
    http.breaker('i1').failure();
    const result = await http.request('i1', 'p', 'http://127.0.0.1:9/never', { method: 'GET' });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'integration.circuit_open',
      attempts: [],
    });
  });
});

describe('local secret store', () => {
  it('encrypts at rest and binds each secret to its organization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hos-secrets-'));
    try {
      const store = new LocalEncryptedSecretStore(dir, randomBytes(32).toString('base64'));
      const ref = await store.put('org-a', { api_key: 'very-secret-value' });
      expect(await store.get('org-a', ref)).toEqual({ api_key: 'very-secret-value' });
      await expect(store.get('org-b', ref)).rejects.toThrow();
      await store.replace('org-a', ref, { api_key: 'rotated' });
      expect(await store.get('org-a', ref)).toEqual({ api_key: 'rotated' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
