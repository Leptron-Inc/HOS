import type { Request } from 'express';
import type { RequestContext } from '../../kernel/public.js';
import type { VerifiedCredential } from '../../modules/iam/public/index.js';

/** Per-request server state, kept off the request's user-controlled fields. */
export interface RequestState {
  readonly requestId: string;
  /** Untrusted, sanitized; recorded for tracing only. */
  readonly clientCorrelationId: string | null;
  readonly startedAt: bigint;
  readonly traceparent: string;
  credential?: VerifiedCredential;
  context?: RequestContext;
}

const STATE = Symbol('hos.request-state');

export function attachRequestState(request: Request, state: RequestState): void {
  (request as unknown as Record<symbol, RequestState>)[STATE] = state;
}

export function requestState(request: Request): RequestState {
  const state = (request as unknown as Record<symbol, RequestState | undefined>)[STATE];
  if (state === undefined)
    throw new Error('request state missing: the request middleware did not run');
  return state;
}

export function requestStateOrUndefined(request: Request): RequestState | undefined {
  return (request as unknown as Record<symbol, RequestState | undefined>)[STATE];
}
