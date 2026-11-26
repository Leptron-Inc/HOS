import { createHash } from 'node:crypto';

/**
 * Canonical JSON (RFC 8785, JSON Canonicalization Scheme): object keys sorted by UTF-16 code
 * units, no whitespace, ECMAScript number serialization. Used for the idempotency fingerprint
 * (F-19) and for audit and security-log hash chains, so the same logical value always hashes the
 * same. Non-finite numbers, undefined values in arrays, functions and symbols are rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('canonical JSON cannot represent a non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonical JSON cannot represent a bigint; use a decimal string');
    case 'object': {
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined)
              throw new TypeError('canonical JSON cannot represent undefined in an array');
            return canonicalJson(item);
          })
          .join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonical JSON cannot represent a ${typeof value}`);
  }
  throw new TypeError('canonical JSON cannot represent this value');
}

export function sha256(...parts: (Buffer | string)[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export const GENESIS_HASH = Buffer.alloc(32);
