import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The browser calls /api/*; the dev and preview servers forward it to the HOS API.
const apiTarget = process.env.HOS_API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
const apiProxy = {
  '/api': {
    target: apiTarget,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
