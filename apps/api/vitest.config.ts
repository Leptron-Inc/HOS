import { defineConfig } from 'vitest/config';

// Decorator metadata (needed by NestJS dependency injection) is checked by
// test/unit/decorator-metadata.test.ts, so a transform change cannot silently break it.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
