import type { Request, Response } from 'express';
import {
  PreconditionRequiredError,
  requestFingerprint,
  ValidationError,
  versionFromIfMatch,
  type IdempotentRequest,
  type WriteResult,
} from '../../kernel/public.js';
import { routeTemplate } from './request-pipeline.interceptor.js';

/** F-06, F-07, F-19: the idempotency facts of a creating POST. */
export function idempotentRequest(request: Request): IdempotentRequest {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 255) {
    throw new ValidationError([
      { path: 'Idempotency-Key', message: 'header is required (1-255 characters)' },
    ]);
  }
  const template = routeTemplate(request) ?? request.path;
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.query)) {
    if (typeof value === 'string') query[name] = value;
    else if (Array.isArray(value))
      query[name] = value.filter((v): v is string => typeof v === 'string');
  }
  return {
    operation: `${request.method} ${template}`,
    key,
    fingerprint: requestFingerprint({
      method: request.method,
      routeTemplate: template,
      pathParams: request.params as Record<string, string>,
      query,
      body: request.body as unknown,
      ifMatch: typeof request.headers['if-match'] === 'string' ? request.headers['if-match'] : null,
    }),
  };
}

/** E-19: updates to versioned resources require If-Match (428 if missing). */
export function requiredVersion(request: Request): number {
  const header = request.headers['if-match'];
  const version = versionFromIfMatch(typeof header === 'string' ? header : undefined);
  if (version === null) throw new PreconditionRequiredError();
  return version;
}

/** Writes a (possibly replayed) idempotent result (F-22). */
export function sendWrite(response: Response, result: WriteResult): unknown {
  response.status(result.status);
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  if (result.replayed === true) response.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}

export function queryString(request: Request, name: string): string | undefined {
  const value = request.query[name];
  return typeof value === 'string' ? value : undefined;
}
