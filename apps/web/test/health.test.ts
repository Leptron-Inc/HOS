import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchApiHealth } from '../src/api/health';

const ready = { status: 'ready', checks: { database: 'up' } };
const notReady = { status: 'not_ready', checks: { database: 'down' } };

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fetch that never answers on its own but rejects when its signal aborts. */
function stubHangingFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    (...[, init]: Parameters<typeof fetch>) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchApiHealth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the readiness path under the configured base URL', async () => {
    const fetchMock = stubFetch(200, ready);
    await fetchApiHealth('/api');
    expect(fetchMock).toHaveBeenCalledWith('/api/health/ready', expect.anything());
  });

  it('classifies 200 + ready as connected', async () => {
    stubFetch(200, ready);
    expect(await fetchApiHealth('/api')).toBe('connected');
  });

  it('classifies 503 + not_ready as degraded', async () => {
    stubFetch(503, notReady);
    expect(await fetchApiHealth('/api')).toBe('degraded');
  });

  it('classifies a network failure as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await fetchApiHealth('/api')).toBe('unreachable');
  });

  it('classifies an invalid body as unreachable', async () => {
    stubFetch(200, { hello: 'world' });
    expect(await fetchApiHealth('/api')).toBe('unreachable');
  });

  it('classifies an unexpected status as unreachable', async () => {
    stubFetch(500, ready);
    expect(await fetchApiHealth('/api')).toBe('unreachable');
  });

  it('gives up after the timeout and reports unreachable', async () => {
    vi.useFakeTimers();
    stubHangingFetch();
    const result = fetchApiHealth('/api', { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('unreachable');
  });

  it('aborts when the caller signal aborts', async () => {
    stubHangingFetch();
    const caller = new AbortController();
    const result = fetchApiHealth('/api', { signal: caller.signal, timeoutMs: 60_000 });
    caller.abort();
    expect(await result).toBe('unreachable');
  });
});
