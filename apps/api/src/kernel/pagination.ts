import { canonicalJson, sha256 } from './canonical-json.js';
import { ValidationError } from './errors.js';

/**
 * Cursor pagination (tenancy specification F-11 to F-13; G9). The order is total (sort key, then
 * id); the cursor is an opaque, versioned base64url token holding the last row's sort values and
 * a hash of the filters. Using a cursor with different filters is a validation error. Cursors
 * grant no access: every page runs under the caller's own context.
 */
export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean };
}

export interface CursorPosition {
  readonly sort: string | number;
  readonly id: string;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

function filterHash(filters: unknown): string {
  return sha256(canonicalJson(filters ?? null))
    .subarray(0, 12)
    .toString('base64url');
}

export function encodeCursor(position: CursorPosition, filters: unknown): string {
  return Buffer.from(
    JSON.stringify({ v: 1, s: position.sort, i: position.id, f: filterHash(filters) }),
  ).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, filters: unknown): CursorPosition | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    if (cursor.length > 512) throw new Error('too long');
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown;
      s?: unknown;
      i?: unknown;
      f?: unknown;
    };
    if (
      value.v !== 1 ||
      typeof value.i !== 'string' ||
      (typeof value.s !== 'string' && typeof value.s !== 'number')
    )
      throw new Error('shape');
    if (value.f !== filterHash(filters)) throw new Error('filters');
    return { sort: value.s, id: value.i };
  } catch {
    throw new ValidationError([{ path: 'cursor', message: 'invalid cursor for these filters' }]);
  }
}

export function pageLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PAGE_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new ValidationError([
      { path: 'limit', message: `must be an integer from 1 to ${MAX_PAGE_LIMIT}` },
    ]);
  }
  return value;
}

/** Builds a page from `limit + 1` fetched rows. */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  position: (row: T) => CursorPosition,
  filters: unknown,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    page: {
      next_cursor: hasMore && last !== undefined ? encodeCursor(position(last), filters) : null,
      has_more: hasMore,
    },
  };
}
