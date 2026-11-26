import { Inject, Injectable } from '@nestjs/common';
import type { DependencyStatus } from '@hos/shared';
import type pg from 'pg';
import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { probeDatabase } from './database-probe.js';
import { RUNTIME_POOL } from './database.tokens.js';

/** Readiness of PostgreSQL through the process's runtime pool (bounded probe, database-probe.ts). */
@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    @Inject(RUNTIME_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async status(): Promise<DependencyStatus> {
    const up = await probeDatabase(this.pool, this.config.database.healthTimeoutMs);
    return up ? 'up' : 'down';
  }
}
