import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from '../../kernel/public.js';
import { continueTrace, traceparent } from '../../kernel/observability/trace.js';
import type { PlatformServices } from '../platform-services.js';
import { ProblemError, problemBody } from './problem.js';
import { routeTemplate } from './request-pipeline.interceptor.js';
import { attachRequestState, requestState } from './request-state.js';

/**
 * First middleware of every request (P6, P7): server request ID, untrusted client correlation ID
 * (sanitized, recorded for tracing only), W3C trace context, secure response headers, a per-source
 * rate limit (protective safeguard, D-013) and request metrics.
 */
export function requestMiddleware(services: PlatformServices) {
  const limiter = new RateLimiter(services.config.security.rateLimitPerMinute);
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestId = uuidv7();
    const rawCorrelation = request.headers['x-correlation-id'];
    const correlation =
      typeof rawCorrelation === 'string'
        ? rawCorrelation.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128)
        : '';
    const trace = continueTrace(
      typeof request.headers.traceparent === 'string' ? request.headers.traceparent : undefined,
    );
    attachRequestState(request, {
      requestId,
      clientCorrelationId: correlation === '' ? null : correlation,
      startedAt: process.hrtime.bigint(),
      traceparent: traceparent(trace),
    });

    // Secure HTTP configuration (P7; technical architecture §10). The API serves JSON only.
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('traceparent', traceparent(trace));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (services.config.nodeEnv === 'production') {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    response.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - requestState(request).startedAt) / 1e9;
      const route = routeTemplate(request) ?? 'unmatched';
      services.metrics.increment('hos_http_requests_total', {
        method: request.method,
        route,
        status: String(response.statusCode),
      });
      services.metrics.observe(
        'hos_http_request_duration_seconds',
        { method: request.method, route },
        seconds,
      );
      services.logger.info('http_request', {
        request_id: requestId,
        method: request.method,
        route,
        status: response.statusCode,
        duration_ms: Math.round(seconds * 1000),
        trace_id: trace.traceId,
      });
    });

    const source = request.socket.remoteAddress ?? 'unknown';
    if (!limiter.allow(source)) {
      services.metrics.increment('hos_rate_limited_total', {});
      const problem = new ProblemError('rate_limited', undefined, [], undefined, {
        'Retry-After': '60',
      });
      response.setHeader('Retry-After', '60');
      response
        .status(429)
        .type('application/problem+json')
        .send(JSON.stringify(problemBody(problem, requestId)));
      return;
    }
    next();
  };
}

/** Fixed-window limiter per source address (rate-limiting foundation; a WAF is the production layer). */
export class RateLimiter {
  private windowStart = 0;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const current = this.now();
    if (current - this.windowStart >= 60_000) {
      this.windowStart = current;
      this.counts.clear();
    }
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= this.perMinute;
  }
}
