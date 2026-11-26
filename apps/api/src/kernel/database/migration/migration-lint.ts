import { splitSqlStatements } from './sql-statements.js';

/**
 * Migration lint (tenancy specification G-16, G-08, G-05, C-19, C-22). It rejects statements that
 * only the bootstrap may run, ownership and trigger changes, PUBLIC grants, SECURITY DEFINER
 * functions outside the C-22 allowlist or created under the wrong owner role, any SET ROLE outside
 * the C-19 pattern, and DML on tenant tables in schema migrations.
 */

/** Definer owner roles a migration may switch to (C-19), and the functions each may own (C-22). */
const DEFINER_OWNERS: Readonly<Record<string, readonly RegExp[]>> = {
  hos_lookup_tenant: [/^kernel\.organization_status$/, /^kernel\.property_status$/],
  hos_lookup_identity: [/^kernel\.resolve_principal$/, /^kernel\.list_memberships$/],
  // P4 webhook endpoint lookup: "added with P4, following the same pattern" (C-21 allowlist row).
  hos_lookup_integration: [/^kernel\.webhook_endpoint_lookup$/],
  hos_history_writer: [/^kernel\.[a-z0-9_]+_capture_version$/],
  hos_history_reader: [/^kernel\.[a-z0-9_]+_history_sensitive$/],
  hos_history_eraser: [/^kernel\.[a-z0-9_]+_erase_history$/],
};

/** global_reference tables (A-10) are the only tables a schema migration may write rows to. */
const GLOBAL_REFERENCE_TABLE = /^app\.ref_[a-z0-9_]+$/;

export interface LintProblem {
  readonly statement: number;
  readonly rule: string;
  readonly message: string;
}

function functionName(statement: string): string | undefined {
  const match = /^CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/i.exec(
    statement,
  );
  return match?.[1]?.toLowerCase();
}

export function lintMigration(sql: string, options: { noTransaction: boolean }): LintProblem[] {
  const problems: LintProblem[] = [];
  const statements = splitSqlStatements(sql);
  let currentRole = 'hos_owner';

  statements.forEach((statement, index) => {
    const top = statement.topLevel;
    const upper = top.toUpperCase();
    const add = (rule: string, message: string) =>
      problems.push({ statement: index + 1, rule, message });

    if (/\b(CREATE|ALTER|DROP)\s+ROLE\b/.test(upper))
      add('G-16', 'role changes belong to the bootstrap (C-23)');
    if (/^GRANT\s/.test(upper) && !/\sON\s/.test(upper)) {
      add('G-16', 'role-membership GRANT belongs to the bootstrap (C-23)');
    }
    if (/^REVOKE\s/.test(upper) && !/\sON\s/.test(upper)) {
      add('G-16', 'role-membership REVOKE belongs to the bootstrap (C-23)');
    }
    if (/\bRESET\s+ROLE\b/.test(upper)) add('G-16', 'RESET ROLE is not allowed');
    if (/\bDISABLE\s+TRIGGER\b/.test(upper)) add('G-16', 'DISABLE TRIGGER is not allowed');
    if (/\bOWNER\s+TO\b/.test(upper)) add('G-16', 'ALTER … OWNER TO is not allowed (C-19)');
    if (/\bTO\s+PUBLIC\b/.test(upper)) add('G-16', 'GRANT … TO PUBLIC is not allowed (C-16)');
    if (/\bBYPASSRLS\b/.test(upper)) add('G-16', 'BYPASSRLS is not allowed (C-01)');
    if (/\bSESSION_REPLICATION_ROLE\b/.test(upper))
      add('G-16', 'session_replication_role is not allowed');
    if (/\bSET\s+(LOCAL\s+|SESSION\s+)?HOS\./.test(upper) || /\bSET_CONFIG\s*\(\s*''/.test(upper)) {
      add('C-07', 'tenant context settings are set only by the kernel');
    }
    if (/\bMATERIALIZED\s+VIEW\b/.test(upper)) add('C-16', 'materialized views are prohibited');
    if (/^CREATE (OR REPLACE )?VIEW\b/.test(upper) && !/SECURITY_INVOKER\s*=\s*TRUE/.test(upper)) {
      add('C-16', 'views must be created WITH (security_invoker = true)');
    }

    const setRole = /^SET\s+ROLE\s+([a-z_][a-z0-9_]*)$/i.exec(top);
    if (setRole) {
      const role = (setRole[1] ?? '').toLowerCase();
      if (role === 'hos_owner') {
        currentRole = role;
      } else if (role in DEFINER_OWNERS) {
        // Switching between definer owner roles is the validated block 10 pattern; the run must
        // still end as hos_owner (checked below and by the runner).
        currentRole = role;
      } else {
        add(
          'G-16',
          `SET ROLE ${role} is not allowed (only definer owner roles and hos_owner, C-19)`,
        );
      }
      return;
    }
    if (/^SET\s+(SESSION\s+)?(ROLE|SESSION AUTHORIZATION)\b/.test(upper)) {
      add('G-16', 'this form of SET ROLE is not allowed');
    }

    if (currentRole !== 'hos_owner') {
      // Under a definer owner role only the C-19 statements may run.
      const allowed =
        /^CREATE (OR REPLACE )?FUNCTION\s/.test(upper) ||
        (/^(REVOKE|GRANT)\s/.test(upper) && /\sON FUNCTION\s/.test(upper)) ||
        /^COMMENT ON FUNCTION\s/.test(upper);
      if (!allowed) add('C-19', `only function statements may run as ${currentRole}`);
    }

    const name = functionName(top);
    if (name !== undefined && /\bSECURITY\s+DEFINER\b/.test(upper)) {
      const allowedFor = Object.entries(DEFINER_OWNERS).find(([, patterns]) =>
        patterns.some((pattern) => pattern.test(name)),
      );
      if (allowedFor === undefined) {
        add('C-22', `SECURITY DEFINER function ${name} is not on the allowlist`);
      } else if (allowedFor[0] !== currentRole) {
        add('C-19', `${name} must be created as ${allowedFor[0]}, not ${currentRole}`);
      }
      if (/\bLEAKPROOF\b/.test(upper))
        add('C-22', 'SECURITY DEFINER functions are never LEAKPROOF');
      if (!/SET SEARCH_PATH\s*=\s*PG_CATALOG,\s*PG_TEMP/.test(upper)) {
        add('C-22', `${name} must SET search_path = pg_catalog, pg_temp`);
      }
    }

    const dml =
      /^(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|MERGE\s+INTO|COPY)\s+(ONLY\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/i.exec(
        top,
      );
    if (dml) {
      const table = (dml[4] ?? '').toLowerCase();
      if (!GLOBAL_REFERENCE_TABLE.test(table)) {
        add(
          'G-08',
          `DML on ${table}: schema migrations may change rows only in global_reference tables`,
        );
      }
    }
  });

  if (currentRole !== 'hos_owner') {
    problems.push({
      statement: statements.length,
      rule: 'G-15',
      message: 'migration must end as hos_owner',
    });
  }
  if (options.noTransaction && statements.length !== 1) {
    problems.push({
      statement: 0,
      rule: 'G-05',
      message: 'a no-transaction migration must contain exactly one statement',
    });
  }
  return problems;
}
