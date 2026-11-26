import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

describe('App shell', () => {
  it('renders the HOS shell with an API status indicator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Platform foundation' })).toBeDefined();
    expect(screen.getByText('HOS')).toBeDefined();
    expect(await screen.findByText('API unreachable')).toBeDefined();
  });
});
