import { isReadinessResponse, READINESS_PATH } from '@hos/shared';

export type ApiHealth = 'connected' | 'degraded' | 'unreachable';

export const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Calls the API readiness endpoint. 200 + ready means connected; 503 + not_ready means
 * degraded (the API runs but a dependency is down); anything else, including a request that
 * exceeds `timeoutMs`, means unreachable.
 */
export async function fetchApiHealth(
  baseUrl: string,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<ApiHealth> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, options.timeoutMs ?? HEALTH_REQUEST_TIMEOUT_MS);
  if (options.signal?.aborted === true) abort();
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(`${baseUrl}${READINESS_PATH}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const body: unknown = await response.json();
    if (!isReadinessResponse(body)) return 'unreachable';
    if (response.status === 200 && body.status === 'ready') return 'connected';
    if (response.status === 503 && body.status === 'not_ready') return 'degraded';
    return 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
