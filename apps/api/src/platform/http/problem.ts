/**
 * RFC 9457 problem details with stable codes (tenancy specification F-03 to F-05). Error bodies
 * never contain stack traces, SQL, other tenants' identifiers or personal values.
 */
export type ProblemCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'state_conflict'
  | 'idempotency_in_progress'
  | 'idempotency_key_reuse'
  | 'precondition_required'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error'
  | 'unavailable';

const STATUS: Record<ProblemCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  state_conflict: 409,
  idempotency_in_progress: 409,
  idempotency_key_reuse: 422,
  precondition_required: 428,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
  unavailable: 503,
};

const TITLES: Record<ProblemCode, string> = {
  validation_failed: 'The request is not valid',
  unauthenticated: 'Authentication is required',
  forbidden: 'The action is not permitted',
  not_found: 'The resource was not found',
  version_conflict: 'The resource was changed by another request',
  state_conflict: 'The resource is not in a state that allows this action',
  idempotency_in_progress: 'A request with the same idempotency key is still running',
  idempotency_key_reuse: 'The idempotency key was used for a different request',
  precondition_required: 'If-Match is required for this update',
  payload_too_large: 'The request body is too large',
  rate_limited: 'Too many requests',
  internal_error: 'An unexpected error occurred',
  unavailable: 'A dependency is temporarily unavailable',
};

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export class ProblemError extends Error {
  readonly status: number;
  constructor(
    readonly code: ProblemCode,
    readonly detail?: string,
    readonly errors: readonly FieldError[] = [],
    /** Module-specific code, namespaced `<module>.<code>` (F-04), for state_conflict. */
    readonly moduleCode?: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail ?? TITLES[code]);
    this.name = 'ProblemError';
    this.status = STATUS[code];
  }
}

export function problemBody(problem: ProblemError, requestId: string): Record<string, unknown> {
  return {
    type: `urn:hos:problem:${problem.moduleCode ?? problem.code}`,
    title: TITLES[problem.code],
    status: problem.status,
    code: problem.moduleCode ?? problem.code,
    ...(problem.detail !== undefined ? { detail: problem.detail } : {}),
    request_id: requestId,
    errors: problem.errors,
  };
}

export const notFound = () => new ProblemError('not_found');
export const forbidden = () => new ProblemError('forbidden');
