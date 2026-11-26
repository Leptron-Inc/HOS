import { Module, type DynamicModule } from '@nestjs/common';
import type pg from 'pg';
import { DatabaseHealthIndicator } from '../kernel/database/database-health.indicator.js';
import { RUNTIME_POOL } from '../kernel/database/database.tokens.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({})
export class HealthModule {
  static forRoot(runtimePool: pg.Pool): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: RUNTIME_POOL, useValue: runtimePool },
        DatabaseHealthIndicator,
        HealthService,
      ],
    };
  }
}
