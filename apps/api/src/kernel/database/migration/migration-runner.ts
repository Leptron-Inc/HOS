import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { lintMigration, type LintProblem } from './migration-lint.js';

/**
 * HOS migration runner. PROVISIONAL: the tenancy specification §11 item 2 leaves the runner
 * unselected (an established tool plus HOS checks, or a small runner kept in the repository).
 * This is the second candidate, written so that the migration files stay plain SQL and remain
 * usable by an established tool if one is selected later.
 *
 * Rules implemented: G-01 forward-only; G-02 strict timestamp order; G-03 checksums; G-05
 * single-statement no-transaction migrations; G-06 session timeouts; G-15 validated session
 * preamble and "every migration ends as hos_owner"; G-16 and G-08 lint (migration-lint.ts).
 */

/** The validated session preamble (tenancy specification §3.3), unchanged. */
export const SESSION_PREAMBLE = `SET ROLE hos_owner;
DO $$
BEGIN
  IF session_user <> 'hos_migrator' OR current_user <> 'hos_owner' THEN
    RAISE EXCEPTION 'migrations must run as hos_migrator under SET ROLE hos_owner (found % / %)',
      session_user, current_user;
  END IF;
END $$;`;

const FILE_NAME = /^(\d{14})_([a-z0-9]+)_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION_MARKER = /^-- hos:no-transaction\s*$/m;

export interface MigrationFile {
  readonly version: string;
  readonly module: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
  readonly noTransaction: boolean;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly problems: readonly LintProblem[] = [],
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const fileName of names) {
    const match = FILE_NAME.exec(fileName);
    if (!match) throw new MigrationError(`Migration file name does not follow G-02: ${fileName}`);
    const version = match[1] ?? '';
    if (seen.has(version)) throw new MigrationError(`Duplicate migration version ${version}`);
    seen.add(version);
    const sql = await readFile(join(directory, fileName), 'utf8');
    if (sql.includes('\r'))
      throw new MigrationError(`${fileName}: CRLF line endings change the checksum`);
    files.push({
      version,
      module: match[2] ?? '',
      fileName,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      noTransaction: NO_TRANSACTION_MARKER.test(sql),
    });
  }
  return files;
}

/** Lints every file; throws with all problems if any file fails (H-MIG-07). */
export function lintMigrations(files: readonly MigrationFile[]): void {
  const problems: LintProblem[] = [];
  const messages: string[] = [];
  for (const file of files) {
    for (const problem of lintMigration(file.sql, { noTransaction: file.noTransaction })) {
      problems.push(problem);
      messages.push(
        `${file.fileName} statement ${problem.statement} [${problem.rule}] ${problem.message}`,
      );
    }
  }
  if (problems.length > 0)
    throw new MigrationError(`Migration lint failed:\n${messages.join('\n')}`, problems);
}

export interface RunMigrationsOptions {
  /** Connection string for hos_migrator. Never logged. */
  readonly connectionString: string;
  readonly directory: string;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly log?: (message: string) => void;
}

export interface RunMigrationsResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

const HISTORY_TABLE = 'hos_migration.schema_migration';

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = options.log ?? (() => undefined);
  const files = await loadMigrations(options.directory);
  lintMigrations(files);

  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: 'hos-migrator',
  });
  await client.connect();
  try {
    // G-15: refuse to run if the preamble's check fails (it raises).
    await client.query(SESSION_PREAMBLE);
    await client.query(
      "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
      [`${options.lockTimeoutMs}ms`, `${options.statementTimeoutMs}ms`],
    );
    // One runner at a time per database.
    await client.query("SELECT pg_advisory_lock(hashtext('hos_migration_runner'))");
    await client.query(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      version     text        PRIMARY KEY,
      file_name   text        NOT NULL,
      module      text        NOT NULL,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`REVOKE ALL ON ${HISTORY_TABLE} FROM PUBLIC`);

    const applied = await client.query<{ version: string; file_name: string; checksum: string }>(
      `SELECT version, file_name, checksum FROM ${HISTORY_TABLE} ORDER BY version`,
    );
    const byVersion = new Map(files.map((file) => [file.version, file]));
    for (const row of applied.rows) {
      const file = byVersion.get(row.version);
      if (file === undefined)
        throw new MigrationError(
          `Applied migration ${row.file_name} is missing from the repository`,
        );
      if (file.checksum !== row.checksum) {
        throw new MigrationError(
          `Applied migration ${row.file_name} was edited (checksum mismatch, G-03)`,
        );
      }
    }
    const newestApplied = applied.rows.at(-1)?.version ?? '';
    const appliedVersions = new Set(applied.rows.map((row) => row.version));
    const pending = files.filter((file) => !appliedVersions.has(file.version));
    const outOfOrder = pending.filter((file) => file.version < newestApplied);
    if (outOfOrder.length > 0) {
      throw new MigrationError(
        `Out-of-order migrations (older than the newest applied, G-02): ${outOfOrder.map((f) => f.fileName).join(', ')}`,
      );
    }

    const done: string[] = [];
    for (const file of pending) {
      log(`applying ${file.fileName}`);
      if (file.noTransaction) {
        await client.query(file.sql);
        await assertOwnerRole(client, file);
        await recordApplied(client, file);
      } else {
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await assertOwnerRole(client, file);
          await recordApplied(client, file);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          // A SET ROLE inside the failed migration is undone by the rollback; re-run the preamble
          // check so a later step can never run under the wrong role.
          throw error;
        }
      }
      done.push(file.fileName);
    }
    return { applied: done, alreadyApplied: applied.rows.length };
  } finally {
    await client.end();
  }
}

async function assertOwnerRole(client: pg.Client, file: MigrationFile): Promise<void> {
  const result = await client.query<{ role: string }>('SELECT current_user AS role');
  if (result.rows[0]?.role !== 'hos_owner') {
    throw new MigrationError(`${file.fileName} did not end as hos_owner (G-15)`);
  }
}

async function recordApplied(client: pg.Client, file: MigrationFile): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_TABLE} (version, file_name, module, checksum) VALUES ($1, $2, $3, $4)`,
    [file.version, file.fileName, file.module, file.checksum],
  );
}
