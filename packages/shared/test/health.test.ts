import { describe, expect, it } from 'vitest';
import {
  isLivenessResponse,
  isReadinessResponse,
  LIVENESS_PATH,
  READINESS_PATH,
  type ReadinessResponse,
} from '../src/health.js';

const ready: ReadinessResponse = { status: 'ready', checks: { database: 'up' } };

describe('health paths', () => {
  it('separates liveness from readiness', () => {
    expect(LIVENESS_PATH).toBe('/health/live');
    expect(READINESS_PATH).toBe('/health/ready');
  });
});

describe('isLivenessResponse', () => {
  it('accepts { status: "ok" }', () => {
    expect(isLivenessResponse({ status: 'ok' })).toBe(true);
  });

  it.each([null, 'ok', { status: 'ready' }, {}])('rejects %j', (value) => {
    expect(isLivenessResponse(value)).toBe(false);
  });
});

describe('isReadinessResponse', () => {
  it('accepts a ready payload', () => {
    expect(isReadinessResponse(ready)).toBe(true);
  });

  it('accepts a not-ready payload', () => {
    expect(isReadinessResponse({ status: 'not_ready', checks: { database: 'down' } })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'ready'],
    ['an unknown status', { ...ready, status: 'ok' }],
    ['a missing database check', { status: 'ready', checks: {} }],
    ['an invalid dependency status', { status: 'ready', checks: { database: 'maybe' } }],
    ['missing checks', { status: 'ready' }],
  ])('rejects %s', (_label, value) => {
    expect(isReadinessResponse(value)).toBe(false);
  });
});
