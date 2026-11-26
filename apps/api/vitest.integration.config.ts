import { defineConfig } from 'vitest/config';

// Integration tests run against a real, migrated throwaway PostgreSQL database (global-setup.ts).
// Files run one at a time: several tests inspect database-wide state (pg_stat_activity, catalog).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
