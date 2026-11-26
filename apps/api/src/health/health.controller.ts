import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { NonTenantRoute } from '../platform/http/route-scope.js';
import {
  LIVENESS_PATH,
  READINESS_PATH,
  type LivenessResponse,
  type ReadinessResponse,
} from '@hos/shared';
import { HealthService } from './health.service.js';

/**
 * Operational endpoints (not part of the versioned business API). Unauthenticated, so the
 * responses carry no versions, timings or error details.
 */
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process serves HTTP. Never touches the database. */
  @Get(LIVENESS_PATH)
  @NonTenantRoute(false)
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  /** Readiness: 200 when PostgreSQL answers, 503 otherwise. Cached for HEALTH_CACHE_TTL_MS. */
  @Get(READINESS_PATH)
  @NonTenantRoute(false)
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    if (result.status !== 'ready') response.status(503);
    return result;
  }
}
