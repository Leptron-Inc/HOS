import { describe, expect, it } from 'vitest';
import { auditRecordHash, redactChanges } from '../../src/kernel/audit/audit-writer.js';
import { canonicalJson, GENESIS_HASH } from '../../src/kernel/canonical-json.js';
import { requestFingerprint } from '../../src/kernel/idempotency/idempotency-store.js';
import { isUuid, uuidv5, uuidv7 } from '../../src/kernel/ids.js';
import { lintMigration } from '../../src/kernel/database/migration/migration-lint.js';
import { collectTables } from '../../src/kernel/database/manifest-plugin.js';
import { redactValue } from '../../src/kernel/observability/logger.js';
import { MetricsRegistry } from '../../src/kernel/observability/metrics.js';
import { continueTrace } from '../../src/kernel/observability/trace.js';
import { decodeCursor, encodeCursor } from '../../src/kernel/pagination.js';
import { backoffMs } from '../../src/kernel/queue/queue.js';
import type { ModuleManifest } from '../../src/kernel/database/manifest.js';

describe('identifiers (E-01, E-03)', () => {
  it('UUIDv7 values are valid, unique and time-ordered; UUIDv5 is deterministic', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    expect(ids.every(isUuid)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]?.[14]).toBe('7');
    const namespace = '6f1d3c2a-5b7e-4f80-9a1c-2d3e4f5a6b7c';
    expect(uuidv5(namespace, 'a')).toBe(uuidv5(namespace, 'a'));
    expect(uuidv5(namespace, 'a')).not.toBe(uuidv5(namespace, 'b'));
    expect(uuidv5(namespace, 'a')[14]).toBe('5');
  });
});

describe('canonical JSON and the idempotency fingerprint (F-19, H-IDEM-09)', () => {
  it('ignores key order and whitespace; any changed value changes the fingerprint', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    const base = {
      method: 'POST',
      routeTemplate: '/v1/x',
      pathParams: { id: '1' },
      query: { b: '2', a: '1' },
      ifMatch: null,
    };
    const one = requestFingerprint({
      ...base,
      body: JSON.parse('{ "name": "A", "code": "B" }') as unknown,
    });
    const two = requestFingerprint({
      ...base,
      body: JSON.parse('{"code":"B","name":"A"}') as unknown,
    });
    const three = requestFingerprint({ ...base, body: { code: 'B', name: 'C' } });
    expect(one.equals(two)).toBe(true);
    expect(one.equals(three)).toBe(false);
    expect(one.length).toBe(32);
  });
});

describe('audit redaction and hashing (map §1.1)', () => {
  const manifest: ModuleManifest = {
    module: 'demo',
    prefix: 'demo_',
    tables: [
      {
        table: 'app.demo_thing',
        scope: 'organization',
        retention: 'operational',
        columns: { name: 'personal', code: 'internal', passport: 'sensitive', token: 'secret' },
      },
    ],
  };
  const entry = (changes: Record<string, { before?: unknown; after?: unknown }>) => ({
    table: 'app.demo_thing',
    action: 'demo.changed',
    entityType: 'thing',
    entityId: uuidv7(),
    entityVersion: 3,
    changes,
  });

  it('keeps internal values, replaces personal and sensitive values with markers, refuses secrets and unknown fields', () => {
    const payload = redactChanges(
      manifest,
      entry({
        code: { before: 'A', after: 'B' },
        name: { after: 'Jane Doe' },
        passport: { after: 'X1234567' },
      }),
    );
    expect(payload.code).toEqual({ before: 'A', after: 'B' });
    expect(JSON.stringify(payload)).not.toMatch(/Jane Doe|X1234567/);
    expect(payload.name?.after).toMatchObject({ redacted: true, class: 'personal' });
    expect(() => redactChanges(manifest, entry({ token: { after: 's3cret' } }))).toThrow(/secret/);
    expect(() => redactChanges(manifest, entry({ unknown_field: { after: 1 } }))).toThrow(
      /not classified/,
    );
  });

  it('the hash chains to the previous record and covers every field', () => {
    const input = {
      id: uuidv7(),
      organization_id: uuidv7(),
      property_id: null,
      sequence: 1,
      recorded_at: new Date(0).toISOString(),
      module: 'demo',
      action: 'a',
      entity_type: 't',
      entity_id: uuidv7(),
      entity_version: 1,
      actor_id: uuidv7(),
      actor_realm: 'machine',
      actor_kind: 'service_identity',
      on_behalf_of_id: null,
      correlation_id: uuidv7(),
      causation_id: null,
      request_id: 'r',
      entry_point: 'api',
      changed_fields: ['x'],
      payload: { x: { after: 1 } },
    };
    const first = auditRecordHash(GENESIS_HASH, input);
    expect(
      auditRecordHash(GENESIS_HASH, { ...input, payload: { x: { after: 2 } } }).equals(first),
    ).toBe(false);
    expect(auditRecordHash(first, input).equals(first)).toBe(false);
  });
});

describe('migration lint (G-16, G-08, C-19, C-22)', () => {
  const problems = (sql: string, noTransaction = false) =>
    lintMigration(sql, { noTransaction }).map((p) => p.rule);
  it('accepts the C-19 definer pattern and rejects bootstrap-only and unsafe statements', () => {
    expect(
      problems(`SET ROLE hos_lookup_tenant;
      CREATE FUNCTION kernel.organization_status(p uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'x' $$;
      REVOKE ALL ON FUNCTION kernel.organization_status(uuid) FROM PUBLIC;
      SET ROLE hos_owner;`),
    ).toEqual([]);
    expect(problems('CREATE ROLE evil LOGIN;')).toContain('G-16');
    expect(problems('GRANT hos_owner TO hos_api;')).toContain('G-16');
    expect(problems('ALTER TABLE app.t DISABLE TRIGGER history_guard;')).toContain('G-16');
    expect(problems('ALTER TABLE app.t OWNER TO hos_api;')).toContain('G-16');
    expect(problems('GRANT SELECT ON app.t TO PUBLIC;')).toContain('G-16');
    expect(problems('SET ROLE hos_api;')).toContain('G-16');
    expect(problems('INSERT INTO app.tenant_department (id) VALUES (1);')).toContain('G-08');
    expect(problems("INSERT INTO app.ref_currency (code) VALUES ('EUR');")).toEqual([]);
    expect(
      problems(
        'CREATE FUNCTION kernel.backdoor() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;',
      ),
    ).toContain('C-22');
    expect(problems('CREATE VIEW app.v AS SELECT 1;')).toContain('C-16');
    expect(problems('SET ROLE hos_history_writer; CREATE TABLE app.x (id int);')).toContain('C-19');
    expect(problems('SET ROLE hos_history_writer;')).toContain('G-15');
    expect(
      problems(
        'CREATE INDEX CONCURRENTLY a ON app.t (x); CREATE INDEX CONCURRENTLY b ON app.t (y);',
        true,
      ),
    ).toContain('G-05');
  });
});

describe('B-07 table extraction', () => {
  it('collects schema-qualified tables and ignores column references to aliases', () => {
    const node = {
      kind: 'SelectQueryNode',
      from: {
        kind: 'FromNode',
        froms: [
          {
            kind: 'AliasNode',
            node: {
              kind: 'TableNode',
              table: { schema: { name: 'app' }, identifier: { name: 'tenant_department' } },
            },
            alias: { name: 'd' },
          },
        ],
      },
      selections: [
        {
          kind: 'ReferenceNode',
          table: { kind: 'TableNode', table: { identifier: { name: 'd' } } },
          column: { kind: 'ColumnNode' },
        },
      ],
    };
    expect(collectTables(node)).toEqual(['app.tenant_department']);
  });
});

describe('observability (P6)', () => {
  it('redacts credentials, tokens, personal keys, card-like numbers and URL passwords', () => {
    const out = JSON.stringify(
      redactValue({
        password: 'x',
        authorization: 'Bearer abc.def.ghi',
        email: 'a@b.c',
        note: 'card 4111 1111 1111 1111 and postgres://u:secret@h/db',
        nested: { token: 't' },
      }),
    );
    expect(out).not.toMatch(/secret@|4111|a@b\.c|abc\.def/);
    expect(out).toMatch(/\[REDACTED\]/);
  });

  it('renders Prometheus text and validates label values', () => {
    const metrics = new MetricsRegistry();
    metrics.increment('hos_test_total', { outcome: 'ok' });
    metrics.increment('hos_test_total', { outcome: 'ok' });
    metrics.observe('hos_test_seconds', {}, 0.02);
    metrics.increment('hos_test_total', { outcome: 'bad value with spaces' });
    const text = metrics.render();
    expect(text).toContain('hos_test_total{outcome="ok"} 2');
    expect(text).toContain('hos_test_total{outcome="invalid"} 1');
    expect(text).toContain('hos_test_seconds_count 1');
  });

  it('continues a valid W3C traceparent and replaces an invalid one', () => {
    const trace = continueTrace('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(trace.sampled).toBe(true);
    expect(continueTrace('garbage').parentSpanId).toBeNull();
  });
});

describe('pagination and backoff', () => {
  it('cursors are bound to their filters (F-12)', () => {
    const cursor = encodeCursor({ sort: 'b', id: 'x' }, { a: 1 });
    expect(decodeCursor(cursor, { a: 1 })).toEqual({ sort: 'b', id: 'x' });
    expect(() => decodeCursor(cursor, { a: 2 })).toThrow();
    expect(() => decodeCursor('not-a-cursor', { a: 1 })).toThrow();
  });

  it('backoff grows exponentially with full jitter and a cap', () => {
    expect(backoffMs(1, 100, 1000, () => 0.999)).toBeLessThan(100);
    expect(backoffMs(4, 100, 1000, () => 0.999)).toBeLessThan(800);
    expect(backoffMs(10, 100, 1000, () => 0.999)).toBeLessThan(1000);
  });
});
