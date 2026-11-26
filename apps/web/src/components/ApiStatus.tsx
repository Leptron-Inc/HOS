import { useEffect, useState } from 'react';
import { fetchApiHealth, type ApiHealth } from '../api/health';

const POLL_INTERVAL_MS = 30_000;

type State = 'checking' | ApiHealth;

const LABELS: Record<State, string> = {
  checking: 'Checking API…',
  connected: 'API connected',
  degraded: 'API degraded',
  unreachable: 'API unreachable',
};

const DETAILS: Partial<Record<State, string>> = {
  degraded: 'Database unavailable',
};

export function ApiStatus({ baseUrl }: { readonly baseUrl: string }) {
  const [state, setState] = useState<State>('checking');

  useEffect(() => {
    const controller = new AbortController();
    const check = () => {
      void fetchApiHealth(baseUrl, { signal: controller.signal }).then((result) => {
        if (!controller.signal.aborted) setState(result);
      });
    };
    check();
    const timer = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [baseUrl]);

  const detail = DETAILS[state];
  return (
    <div className={`api-status api-status--${state}`} role="status" aria-live="polite">
      <span className="api-status__dot" aria-hidden="true" />
      <span className="api-status__label">{LABELS[state]}</span>
      {detail === undefined ? null : <span className="api-status__detail">{detail}</span>}
    </div>
  );
}
