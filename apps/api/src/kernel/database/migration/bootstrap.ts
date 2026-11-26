import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Applies the versioned bootstrap script (tenancy specification C-23, G-17) for local development
 * and automated tests. In AWS environments the bootstrap is applied by the gated pipeline, and
 * only with founder approval (D-025); this tool never runs there.
 *
 * Revisions are recorded where the administrator can record them without any HOS table:
 * cluster revisions as the comment on role hos_owner, database revisions as the comment on the
 * database. Each revision runs in one transaction together with that record.
 */
const REVISION = /^(\d{4})_[a-z0-9_]+\.sql$/;
const MARKER = /^hos-bootstrap:(\d{4})$/;

async function revisions(
  directory: string,
): Promise<{ number: number; file: string; sql: string }[]> {
  const names = (await readdir(directory)).filter((name) => REVISION.test(name)).sort();
  return Promise.all(
    names.map(async (file) => ({
      number: Number(REVISION.exec(file)?.[1]),
      file,
      sql: await readFile(join(directory, file), 'utf8'),
    })),
  );
}

export interface BootstrapResult {
  readonly cluster: readonly string[];
  readonly database: readonly string[];
}

/**
 * @param adminConnectionString the database administrator, connected to the cell database.
 *   Never logged.
 */
export async function applyBootstrap(
  adminConnectionString: string,
  bootstrapDirectory: string,
): Promise<BootstrapResult> {
  const client = new pg.Client({
    connectionString: adminConnectionString,
    application_name: 'hos-bootstrap',
  });
  await client.connect();
  try {
    const clusterApplied: string[] = [];
    const databaseApplied: string[] = [];

    const ownerComment = await client.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_authid') AS comment FROM pg_roles WHERE rolname = 'hos_owner'",
    );
    let clusterRevision = 0;
    if (ownerComment.rows.length > 0) {
      clusterRevision = Number(MARKER.exec(ownerComment.rows[0]?.comment ?? '')?.[1] ?? '1');
    }
    for (const revision of await revisions(join(bootstrapDirectory, 'cluster'))) {
      if (revision.number <= clusterRevision) continue;
      await inTransaction(client, async () => {
        await client.query(revision.sql);
        await client.query(
          `COMMENT ON ROLE hos_owner IS 'hos-bootstrap:${String(revision.number).padStart(4, '0')}'`,
        );
      });
      clusterApplied.push(revision.file);
    }

    const dbComment = await client.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = current_database()",
    );
    const databaseRevision = Number(MARKER.exec(dbComment.rows[0]?.comment ?? '')?.[1] ?? '0');
    for (const revision of await revisions(join(bootstrapDirectory, 'database'))) {
      if (revision.number <= databaseRevision) continue;
      await inTransaction(client, async () => {
        await client.query(revision.sql);
        await client.query(
          `DO $$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'hos-bootstrap:${String(
            revision.number,
          ).padStart(4, '0')}'); END $$`,
        );
      });
      databaseApplied.push(revision.file);
    }
    return { cluster: clusterApplied, database: databaseApplied };
  } finally {
    await client.end();
  }
}

async function inTransaction(client: pg.Client, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
