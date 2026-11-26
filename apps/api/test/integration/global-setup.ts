import type { TestProject } from 'vitest/node';
import {
  createTestDatabase,
  dropTestDatabase,
  type TestDatabaseUrls,
} from '../support/test-database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    hosDb: TestDatabaseUrls;
  }
}

/** One migrated throwaway database for the integration run; dropped afterwards. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const urls = await createTestDatabase();
  project.provide('hosDb', urls);
  return async () => {
    await dropTestDatabase(urls.database);
  };
}
