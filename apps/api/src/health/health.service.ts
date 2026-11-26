import { Inject, Injectable } from '@nestjs/common';
import type { ReadinessResponse } from '@hos/shared';
import type { AppConfig } from '../config/app-config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { DatabaseHealthIndicator } from '../kernel/database/database-health.indicator.js';

/**
 * Readiness with a short, bounded cache. Repeated requests within HEALTH_CACHE_TTL_MS reuse the
 * last result, and concurrent requests share one in-flight probe, so a burst of health
 * requests causes at most one database probe per TTL.
 */
@Injectable()
export class HealthService {
  private cached: { readonly result: ReadinessResponse; readonly checkedAt: number } | undefined;
  private inFlight: Promise<ReadinessResponse> | undefined;

  constructor(
    private readonly database: DatabaseHealthIndicator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  readiness(): Promise<ReadinessResponse> {
    const ttl = this.config.health.cacheTtlMs;
    if (this.cached !== undefined && Date.now() - this.cached.checkedAt < ttl) {
      return Promise.resolve(this.cached.result);
    }
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probe(): Promise<ReadinessResponse> {
    const database = await this.database.status();
    const result: ReadinessResponse = Object.freeze({
      status: database === 'up' ? 'ready' : 'not_ready',
      checks: Object.freeze({ database }),
    });
    this.cached = { result, checkedAt: Date.now() };
    return result;
  }
}
