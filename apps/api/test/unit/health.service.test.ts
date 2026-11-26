import 'reflect-metadata';
import type { DependencyStatus } from '@hos/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/app-config.js';
import { HealthService } from '../../src/health/health.service.js';
import type { DatabaseHealthIndicator } from '../../src/kernel/database/database-health.indicator.js';

// Test double: a probe whose answers and timing the test controls.
class ScriptedDatabaseHealth {
  calls = 0;
  private pending: ((value: DependencyStatus) => void) | undefined;
  constructor(public next: DependencyStatus) {}

  status(): Promise<DependencyStatus> {
    this.calls += 1;
    return Promise.resolve(this.next);
  }

  /** Makes the next probe wait until resolvePending() is called. */
  hold(): void {
    this.status = () => {
      this.calls += 1;
      return new Promise<DependencyStatus>((resolve) => {
        this.pending = resolve;
      });
    };
  }

  resolvePending(value: DependencyStatus): void {
    this.pending?.(value);
  }
}

function serviceWith(probe: ScriptedDatabaseHealth, cacheTtlMs: number): HealthService {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u@h:5432/d',
    HEALTH_CACHE_TTL_MS: String(cacheTtlMs),
  });
  return new HealthService(probe as unknown as DatabaseHealthIndicator, config);
}

describe('HealthService readiness cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the last result within the TTL (one probe for repeated requests)', async () => {
    const probe = new ScriptedDatabaseHealth('up');
    const service = serviceWith(probe, 2000);
    for (let i = 0; i < 5; i += 1) {
      expect((await service.readiness()).status).toBe('ready');
    }
    expect(probe.calls).toBe(1);
  });

  it('shares one in-flight probe between concurrent requests', async () => {
    const probe = new ScriptedDatabaseHealth('up');
    probe.hold();
    const service = serviceWith(probe, 2000);
    const results = Promise.all([service.readiness(), service.readiness(), service.readiness()]);
    probe.resolvePending('up');
    expect((await results).map((r) => r.status)).toEqual(['ready', 'ready', 'ready']);
    expect(probe.calls).toBe(1);
  });

  it('probes again once the TTL has passed', async () => {
    const probe = new ScriptedDatabaseHealth('up');
    const service = serviceWith(probe, 2000);
    await service.readiness();
    vi.setSystemTime(new Date('2026-11-27T10:00:01.999Z'));
    await service.readiness();
    expect(probe.calls).toBe(1);
    vi.setSystemTime(new Date('2026-11-27T10:00:02.000Z'));
    await service.readiness();
    expect(probe.calls).toBe(2);
  });

  it('reports a database failure, keeps it for the TTL, then recovers', async () => {
    const probe = new ScriptedDatabaseHealth('down');
    const service = serviceWith(probe, 2000);
    expect(await service.readiness()).toEqual({
      status: 'not_ready',
      checks: { database: 'down' },
    });

    probe.next = 'up';
    vi.setSystemTime(new Date('2026-11-27T10:00:01.000Z'));
    expect((await service.readiness()).status).toBe('not_ready'); // still cached

    vi.setSystemTime(new Date('2026-11-27T10:00:02.500Z'));
    expect(await service.readiness()).toEqual({ status: 'ready', checks: { database: 'up' } });
    expect(probe.calls).toBe(2);
  });

  it('probes on every request when the cache is disabled (TTL 0)', async () => {
    const probe = new ScriptedDatabaseHealth('up');
    const service = serviceWith(probe, 0);
    await service.readiness();
    await service.readiness();
    expect(probe.calls).toBe(2);
  });

  it('returns frozen results', async () => {
    const result = await serviceWith(new ScriptedDatabaseHealth('up'), 2000).readiness();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.checks)).toBe(true);
  });
});
