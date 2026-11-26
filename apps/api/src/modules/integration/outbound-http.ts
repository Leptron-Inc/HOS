/**
 * Outbound calls to external systems (P4; technical architecture §7): a timeout per attempt,
 * retries with exponential backoff and full jitter for network errors, 429 and 5xx, a circuit
 * breaker per connector instance, and a rate limit per provider type. Every attempt is reported so
 * the caller can write integration logs (outcomes and timings only, never credentials or bodies).
 */
export interface AttemptRecord {
  readonly attempt: number;
  readonly outcome: 'success' | 'failure' | 'retry';
  readonly statusCode: number | null;
  readonly durationMs: number;
  readonly errorCode: string | null;
}

export interface OutboundResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly body: string;
  readonly attempts: readonly AttemptRecord[];
  readonly errorCode: string | null;
}

export interface OutboundOptions {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly breakerThreshold: number;
  readonly breakerCooldownMs: number;
  readonly ratePerMinute: number;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_OUTBOUND: OutboundOptions = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  backoffBaseMs: 200,
  backoffCapMs: 5_000,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
  ratePerMinute: 600,
};

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number,
  ) {}
  get open(): boolean {
    return this.now() < this.openUntil;
  }
  success(): void {
    this.failures = 0;
  }
  failure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.failures = 0;
    }
  }
}

export class OutboundHttp {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly options: OutboundOptions;

  constructor(options: Partial<OutboundOptions> = {}) {
    this.options = { ...DEFAULT_OUTBOUND, ...options };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  breaker(instanceId: string): CircuitBreaker {
    let breaker = this.breakers.get(instanceId);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(
        this.options.breakerThreshold,
        this.options.breakerCooldownMs,
        () => this.now(),
      );
      this.breakers.set(instanceId, breaker);
    }
    return breaker;
  }

  private allowRate(provider: string): boolean {
    const now = this.now();
    const window = this.windows.get(provider);
    if (window === undefined || now - window.start >= 60_000) {
      this.windows.set(provider, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.options.ratePerMinute;
  }

  async request(
    instanceId: string,
    provider: string,
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<OutboundResult> {
    const attempts: AttemptRecord[] = [];
    const breaker = this.breaker(instanceId);
    if (breaker.open)
      return { ok: false, status: null, body: '', attempts, errorCode: 'integration.circuit_open' };
    if (!this.allowRate(provider))
      return { ok: false, status: null, body: '', attempts, errorCode: 'integration.rate_limited' };
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const started = this.now();
      let status: number | null = null;
      let body = '';
      let errorCode: string | null = null;
      try {
        const response = await fetch(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        status = response.status;
        body = (await response.text()).slice(0, 1_000_000);
      } catch (error) {
        errorCode =
          error instanceof Error && error.name === 'TimeoutError'
            ? 'integration.timeout'
            : 'integration.network_error';
      }
      const durationMs = Math.max(0, this.now() - started);
      const retryable = status === null || status === 429 || status >= 500;
      if (status !== null && status >= 200 && status < 300) {
        attempts.push({
          attempt,
          outcome: 'success',
          statusCode: status,
          durationMs,
          errorCode: null,
        });
        breaker.success();
        return { ok: true, status, body, attempts, errorCode: null };
      }
      const last = attempt === this.options.maxAttempts || !retryable;
      const code = errorCode ?? `integration.http_${status ?? 0}`;
      attempts.push({
        attempt,
        outcome: last ? 'failure' : 'retry',
        statusCode: status,
        durationMs,
        errorCode: code,
      });
      if (last) {
        breaker.failure();
        return { ok: false, status, body, attempts, errorCode: code };
      }
      const ceiling = Math.min(
        this.options.backoffCapMs,
        this.options.backoffBaseMs * 2 ** (attempt - 1),
      );
      await sleep(Math.floor((this.options.random ?? Math.random)() * ceiling));
    }
    return { ok: false, status: null, body: '', attempts, errorCode: 'integration.exhausted' };
  }
}
