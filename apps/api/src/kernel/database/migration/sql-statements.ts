/**
 * Splits a PostgreSQL script into top-level statements, respecting single-quoted strings,
 * quoted identifiers, dollar-quoted bodies and comments. Used by the migration lint (G-16) and
 * by the single-statement check for no-transaction migrations (G-05). It does not parse SQL;
 * it only finds statement boundaries, which is all those checks need.
 */
export interface SqlStatement {
  /** Statement text with comments removed and whitespace collapsed (for pattern checks). */
  readonly normalized: string;
  /** Statement text with dollar-quoted bodies and string literals blanked out. */
  readonly topLevel: string;
}

export function splitSqlStatements(script: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let normalized = '';
  let topLevel = '';
  let i = 0;
  const n = script.length;

  const flush = () => {
    const norm = normalized.replace(/\s+/g, ' ').trim();
    if (norm !== '') {
      statements.push({ normalized: norm, topLevel: topLevel.replace(/\s+/g, ' ').trim() });
    }
    normalized = '';
    topLevel = '';
  };

  while (i < n) {
    const ch = script[i] ?? '';
    const next = script[i + 1] ?? '';
    if (ch === '-' && next === '-') {
      const end = script.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      normalized += ' ';
      topLevel += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (script[i] === '/' && script[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (script[i] === '*' && script[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      normalized += ' ';
      topLevel += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (script[j] === quote) {
          if (script[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const literal = script.slice(i, j + 1);
      normalized += literal;
      topLevel += quote === '"' ? literal : "''";
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i));
      if (match) {
        const tag = match[0];
        const end = script.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        normalized += script.slice(i, stop);
        topLevel += ' $body$ ';
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }
    normalized += ch;
    topLevel += ch;
    i += 1;
  }
  flush();
  return statements;
}
