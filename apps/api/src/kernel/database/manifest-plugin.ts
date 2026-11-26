import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';
import { TableNotInManifestError } from './manifest.js';

/**
 * Enforces B-07 on every query a module builds: each table the query names must be in the
 * calling module's manifest, schema-qualified. Raw top-level queries are refused, because their
 * tables can't be checked and they could carry string-built SQL (C-14).
 */
export class ManifestPlugin implements KyselyPlugin {
  constructor(
    private readonly module: string,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    if ((args.node.kind as string) === 'RawNode') {
      throw new Error(
        `Module ${this.module}: raw SQL queries are not allowed in a tenant transaction`,
      );
    }
    for (const table of collectTables(args.node)) {
      if (!this.allowed.has(table)) throw new TableNotInManifestError(this.module, table);
    }
    return args.node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

interface NodeLike {
  readonly kind?: unknown;
  readonly [key: string]: unknown;
}

function identifierName(node: unknown): string | undefined {
  const value = (node as NodeLike | undefined)?.name;
  return typeof value === 'string' ? value : undefined;
}

export function collectTables(root: unknown): string[] {
  const found: string[] = [];
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    const candidate = node as NodeLike;
    // A column reference (`d.id`) names a table alias, not a table: only its column matters.
    if (candidate.kind === 'ReferenceNode') {
      stack.push(candidate.column);
      continue;
    }
    if (candidate.kind === 'TableNode') {
      const table = candidate.table as NodeLike;
      const schema = identifierName(table.schema);
      const name = identifierName(table.identifier);
      found.push(
        schema === undefined ? `<unqualified>.${name ?? '?'}` : `${schema}.${name ?? '?'}`,
      );
      continue;
    }
    for (const value of Object.values(candidate)) {
      if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }
  return found;
}
