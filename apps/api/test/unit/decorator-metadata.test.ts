import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../../src/health/health.controller.js';
import { HealthService } from '../../src/health/health.service.js';
import { DatabaseHealthIndicator } from '../../src/kernel/database/database-health.indicator.js';

// Guard test: NestJS resolves class-typed constructor parameters from emitted
// "design:paramtypes" metadata. If the test transform stops emitting it, this fails first.
describe('decorator metadata', () => {
  it('is emitted for HealthController', () => {
    expect(Reflect.getMetadata('design:paramtypes', HealthController)).toEqual([HealthService]);
  });

  it('is emitted for HealthService (class plus interface-typed token parameter)', () => {
    expect(Reflect.getMetadata('design:paramtypes', HealthService)).toEqual([
      DatabaseHealthIndicator,
      Object,
    ]);
  });
});
