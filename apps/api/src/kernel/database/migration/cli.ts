import { fileURLToPath } from 'node:url';
import { applyBootstrap } from './bootstrap.js';
import {
  lintMigrations,
  loadMigrations,
  MigrationError,
  runMigrations,
} from './migration-runner.js';

/**
 * Database tooling entry point:
 *   node dist/kernel/database/migration/cli.js bootstrap   (local and test only; needs HOS_DB_ADMIN_URL)
 *   node dist/kernel/database/migration/cli.js migrate     (needs HOS_DB_MIGRATOR_URL)
 *   node dist/kernel/database/migration/cli.js lint
 * Connection strings come from the environment and are never printed.
 */
export const DB_DIRECTORY = fileURLToPath(new URL('../../../../db/', import.meta.url));
export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../../db/migrations/', import.meta.url),
);
export const BOOTSTRAP_DIRECTORY = fileURLToPath(
  new URL('../../../../db/bootstrap/', import.meta.url),
);

function required(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (value === '') throw new MigrationError(`${name} is required`);
  return value;
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new MigrationError(`${name} must be a positive integer`);
  return value;
}

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case 'bootstrap': {
      if (process.env.NODE_ENV === 'production') {
        throw new MigrationError(
          'The bootstrap tool is for local and test databases only (C-23, D-025).',
        );
      }
      const result = await applyBootstrap(required('HOS_DB_ADMIN_URL'), BOOTSTRAP_DIRECTORY);
      print(
        `bootstrap: cluster ${result.cluster.length} revision(s), database ${result.database.length} revision(s) applied`,
      );
      return;
    }
    case 'migrate': {
      const result = await runMigrations({
        connectionString: required('HOS_DB_MIGRATOR_URL'),
        directory: MIGRATIONS_DIRECTORY,
        lockTimeoutMs: positive('HOS_MIGRATION_LOCK_TIMEOUT_MS', 5_000),
        statementTimeoutMs: positive('HOS_MIGRATION_STATEMENT_TIMEOUT_MS', 600_000),
        log: (message) => print(message),
      });
      print(`migrate: ${result.applied.length} applied, ${result.alreadyApplied} already applied`);
      return;
    }
    case 'lint': {
      const files = await loadMigrations(MIGRATIONS_DIRECTORY);
      lintMigrations(files);
      print(`lint: ${files.length} migration(s) pass`);
      return;
    }
    case undefined:
    default:
      throw new MigrationError('usage: cli.js bootstrap | migrate | lint');
  }
}

try {
  await main(process.argv[2]);
} catch (error: unknown) {
  // Driver errors can include connection details; print the class and code only.
  if (error instanceof MigrationError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    console.error(`${error.name}${typeof code === 'string' ? ` (${code})` : ''}: ${error.message}`);
  }
  process.exitCode = 1;
}
