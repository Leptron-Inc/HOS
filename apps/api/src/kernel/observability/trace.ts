import { randomBytes } from 'node:crypto';

/**
 * Distributed tracing foundation (P6): W3C Trace Context (`traceparent`) propagation. An incoming
 * traceparent is accepted only if it is well formed; its trace ID continues, and a new span ID is
 * created for this service. The trace ID is logged with each record. An OpenTelemetry exporter is
 * deferred: it adds dependencies and needs an approved collector destination (D-025).
 */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly sampled: boolean;
}

export function continueTrace(incoming: string | undefined): TraceContext {
  const match = incoming === undefined ? null : TRACEPARENT.exec(incoming.trim().toLowerCase());
  const traceId = match?.[1];
  if (match && traceId !== undefined && !/^0+$/.test(traceId) && !/^0+$/.test(match[2] ?? '')) {
    return {
      traceId,
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: match[2] ?? null,
      sampled: (parseInt(match[3] ?? '0', 16) & 1) === 1,
    };
  }
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    parentSpanId: null,
    sampled: false,
  };
}

export function traceparent(trace: TraceContext): string {
  return `00-${trace.traceId}-${trace.spanId}-${trace.sampled ? '01' : '00'}`;
}
