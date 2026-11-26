import { currentContextOrUndefined } from '../context/context-store.js';

/**
 * Structured logging (P6; tenancy specification E-29; technical architecture §9). One JSON object
 * per line. Messages are fixed event codes; fields pass through redaction BEFORE they are written:
 * keys that name credentials, tokens or personal data are replaced, and values that look like
 * bearer tokens, card numbers, email addresses or connection strings are masked. Logs never carry
 * personal, sensitive or secret values.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[_-]?key|credential|private|signature|session|card|pan|cvv|email|phone|name|address|birth|document|passport|body/i;
const VALUE_PATTERNS: readonly [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_NUMBER]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, '[REDACTED_URL_CREDENTIALS]@'],
  [/([?&](?:X-Amz-Signature|signature|sig|token)=)[^&\s]+/gi, '$1[REDACTED]'],
];
const MAX_STRING = 500;
const MAX_DEPTH = 5;

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let masked = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    for (const [pattern, replacement] of VALUE_PATTERNS)
      masked = masked.replace(pattern, replacement);
    return masked;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item, depth + 1);
    }
    return out;
  }
  return '[UNSUPPORTED]';
}

export interface LogSink {
  write(line: string): void;
}

export class Logger {
  constructor(
    private readonly component: string,
    private readonly minLevel: LogLevel = 'info',
    private readonly sink: LogSink = { write: (line) => process.stdout.write(`${line}\n`) },
    private readonly base: Readonly<Record<string, unknown>> = {},
  ) {}

  child(component: string, fields: Readonly<Record<string, unknown>> = {}): Logger {
    return new Logger(component, this.minLevel, this.sink, { ...this.base, ...fields });
  }

  log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const ctx = currentContextOrUndefined();
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      component: this.component,
      event: /^[a-z][a-z0-9_.]{0,127}$/.test(event) ? event : 'invalid_event_code',
      ...(ctx !== undefined
        ? {
            request_id: ctx.requestId,
            correlation_id: ctx.correlationId,
            organization_id: ctx.tenant.organizationId,
            actor_id: ctx.actor.id,
            entry_point: ctx.entryPoint,
          }
        : {}),
      ...(redactValue({ ...this.base, ...fields }) as Record<string, unknown>),
    };
    try {
      this.sink.write(JSON.stringify(record));
    } catch {
      // Logging must never break the request.
    }
  }

  debug(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log('debug', event, fields);
  }
  info(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log('info', event, fields);
  }
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log('warn', event, fields);
  }
  error(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log('error', event, fields);
  }
}

/** Safe description of an unknown error for logs: class, SQLSTATE or errno code, never the message. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error_class: typeof error };
  const code = (error as { code?: unknown }).code;
  return { error_class: error.name, ...(typeof code === 'string' ? { error_code: code } : {}) };
}
