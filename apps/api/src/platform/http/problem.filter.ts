import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import {
  ContextMissingError,
  DependencyUnavailableError,
  IdempotencyInProgressError,
  IdempotencyKeyReuseError,
  isDatabaseError,
  NotFoundError,
  PreconditionRequiredError,
  StateConflictError,
  ValidationError,
  VersionConflictError,
  errorFields,
} from '../../kernel/public.js';
import type { PlatformServices } from '../platform-services.js';
import { ProblemError, problemBody } from './problem.js';
import { requestStateOrUndefined } from './request-state.js';

/** Maps every error to RFC 9457 problem details (F-03); never leaks internals (F-05). */
export function toProblem(error: unknown): ProblemError {
  if (error instanceof ProblemError) return error;
  if (error instanceof ValidationError)
    return new ProblemError('validation_failed', undefined, error.errors);
  if (error instanceof NotFoundError) return new ProblemError('not_found');
  if (error instanceof VersionConflictError) {
    return new ProblemError(
      'version_conflict',
      error.currentVersion !== undefined
        ? `Current version is ${error.currentVersion}.`
        : undefined,
    );
  }
  if (error instanceof StateConflictError)
    return new ProblemError('state_conflict', undefined, [], error.code);
  if (error instanceof PreconditionRequiredError) return new ProblemError('precondition_required');
  if (error instanceof IdempotencyKeyReuseError) return new ProblemError('idempotency_key_reuse');
  if (error instanceof IdempotencyInProgressError)
    return new ProblemError('idempotency_in_progress', undefined, [], undefined, {
      'Retry-After': '1',
    });
  if (error instanceof DependencyUnavailableError)
    return new ProblemError('unavailable', undefined, [], undefined, { 'Retry-After': '5' });
  if (error instanceof ContextMissingError) return new ProblemError('not_found');
  if (isDatabaseError(error, '40001') || isDatabaseError(error, '40P01'))
    return new ProblemError('unavailable', undefined, [], undefined, { 'Retry-After': '1' });
  // Constraint violations caused by request values. The answer is the same whether a referenced row
  // does not exist or belongs to another tenant (composite foreign keys, B-10), so nothing leaks.
  if (isDatabaseError(error, '23503'))
    return new ProblemError('validation_failed', 'A referenced resource does not exist.');
  if (
    isDatabaseError(error, '23514') ||
    isDatabaseError(error, '22001') ||
    isDatabaseError(error, '22P02')
  ) {
    return new ProblemError('validation_failed', 'A value is not allowed.');
  }
  if (isDatabaseError(error, '23505'))
    return new ProblemError('state_conflict', undefined, [], 'conflict.duplicate');
  if (isDatabaseError(error, '55P03'))
    return new ProblemError('unavailable', undefined, [], undefined, { 'Retry-After': '1' });
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 404) return new ProblemError('not_found');
    if (status === 413) return new ProblemError('payload_too_large');
    if (status === 400)
      return new ProblemError('validation_failed', 'The request body is not valid JSON.');
    if (status === 405) return new ProblemError('not_found');
  }
  return new ProblemError('internal_error');
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly services: PlatformServices) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const problem = toProblem(error);
    const requestId = requestStateOrUndefined(request)?.requestId ?? 'unknown';
    if (problem.status >= 500) {
      // Error tracking foundation (P6): a stable fingerprint per error class and code, no message.
      const fields = errorFields(error);
      const fingerprint = createHash('sha256')
        .update(
          `${typeof fields.error_class === 'string' ? fields.error_class : 'unknown'}:${typeof fields.error_code === 'string' ? fields.error_code : ''}`,
        )
        .digest('hex')
        .slice(0, 16);
      this.services.metrics.increment('hos_errors_total', { fingerprint, code: problem.code });
      this.services.logger.error('request_failed', {
        request_id: requestId,
        fingerprint,
        ...fields,
      });
    }
    if (response.headersSent) return;
    for (const [name, value] of Object.entries(problem.headers)) response.setHeader(name, value);
    response
      .status(problem.status)
      .type('application/problem+json')
      .send(JSON.stringify(problemBody(problem, requestId)));
  }
}
