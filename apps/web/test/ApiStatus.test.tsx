import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiStatus } from '../src/components/ApiStatus';

function respond(status: number, payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status }))),
  );
}

describe('ApiStatus', () => {
  it('starts in the checking state', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(<ApiStatus baseUrl="/api" />);
    expect(screen.getByRole('status').textContent).toContain('Checking API');
  });

  it('shows connected when the API is ready', async () => {
    respond(200, { status: 'ready', checks: { database: 'up' } });
    render(<ApiStatus baseUrl="/api" />);
    expect(await screen.findByText('API connected')).toBeDefined();
  });

  it('shows degraded when the database is down', async () => {
    respond(503, { status: 'not_ready', checks: { database: 'down' } });
    render(<ApiStatus baseUrl="/api" />);
    expect(await screen.findByText('API degraded')).toBeDefined();
    expect(screen.getByText('Database unavailable')).toBeDefined();
  });

  it('shows unreachable when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    render(<ApiStatus baseUrl="/api" />);
    expect(await screen.findByText('API unreachable')).toBeDefined();
  });
});
