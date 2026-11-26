/**
 * Contracts for the API health endpoints, shared by apps/api (producer) and apps/web (consumer).
 * Contracts only: no framework, database or business logic belongs in this package.
 *
 * - Liveness: the process is running and serving HTTP. It never touches dependencies.
 * - Readiness: the API can serve requests that need its dependencies (currently PostgreSQL).
 *
 * Both endpoints are unauthenticated, so their bodies are deliberately minimal: no versions,
 * timings, host names or error details.
 */
export const LIVENESS_PATH = '/health/live';
export const READINESS_PATH = '/health/ready';

export interface LivenessResponse {
  readonly status: 'ok';
}

export type ReadinessStatus = 'ready' | 'not_ready';
export type DependencyStatus = 'up' | 'down';

export interface ReadinessResponse {
  readonly status: ReadinessStatus;
  readonly checks: {
    readonly database: DependencyStatus;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Runtime validation of an untrusted liveness payload. */
export function isLivenessResponse(value: unknown): value is LivenessResponse {
  return isRecord(value) && value.status === 'ok';
}

/** Runtime validation of an untrusted readiness payload (for example an HTTP response body). */
export function isReadinessResponse(value: unknown): value is ReadinessResponse {
  return (
    isRecord(value) &&
    (value.status === 'ready' || value.status === 'not_ready') &&
    isRecord(value.checks) &&
    (value.checks.database === 'up' || value.checks.database === 'down')
  );
}
