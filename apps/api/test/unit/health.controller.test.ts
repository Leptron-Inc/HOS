import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { isLivenessResponse, isReadinessResponse, type DependencyStatus } from '@hos/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/app-config.js';
import { APP_CONFIG } from '../../src/config/config.module.js';
import { HealthController } from '../../src/health/health.controller.js';
import { HealthService } from '../../src/health/health.service.js';
import { DatabaseHealthIndicator } from '../../src/kernel/database/database-health.indicator.js';

// Test double for the database probe only; the real probe is exercised by the integration tests.
class StubDatabaseHealth {
  calls = 0;
  constructor(private readonly result: DependencyStatus) {}
  status(): Promise<DependencyStatus> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

/** Captures the status the controller sets on the response. */
function fakeResponse() {
  const state = { status: 200 };
  const response = {
    status: (code: number) => {
      state.status = code;
      return response;
    },
  };
  return { response: response as never, state };
}

async function controllerWith(result: DependencyStatus) {
  const stub = new StubDatabaseHealth(result);
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: DatabaseHealthIndicator, useValue: stub },
      {
        provide: APP_CONFIG,
        useValue: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://u@h:5432/d' }),
      },
    ],
  }).compile();
  return { controller: moduleRef.get(HealthController), stub };
}

describe('HealthController', () => {
  it('liveness answers ok without touching the database', async () => {
    const { controller, stub } = await controllerWith('down');
    const body = controller.live();
    expect(isLivenessResponse(body)).toBe(true);
    expect(body).toEqual({ status: 'ok' });
    expect(stub.calls).toBe(0);
  });

  it('readiness answers ready when the database is up, with a minimal body', async () => {
    const { controller } = await controllerWith('up');
    const { response, state } = fakeResponse();
    const body = await controller.ready(response);
    expect(state.status).toBe(200);
    expect(isReadinessResponse(body)).toBe(true);
    // No versions, timings or other internal details.
    expect(body).toEqual({ status: 'ready', checks: { database: 'up' } });
  });

  it('readiness answers 503 not_ready when the database is down', async () => {
    const { controller } = await controllerWith('down');
    const { response, state } = fakeResponse();
    const body = await controller.ready(response);
    expect(state.status).toBe(503);
    expect(body).toEqual({ status: 'not_ready', checks: { database: 'down' } });
  });
});
