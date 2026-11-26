import { createHash, randomBytes } from 'node:crypto';

/** Identifiers (tenancy specification E-01 to E-04). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function format(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

let lastMs = -1;
let sequence = 0;

/** UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then randomness. Monotonic within one process. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = now;
  if (ms <= lastMs) {
    ms = lastMs;
    sequence = (sequence + 1) & 0xfff;
    if (sequence === 0) ms = lastMs + 1;
  } else {
    sequence = bytes.readUInt16BE(6) & 0x7ff;
  }
  lastMs = ms;
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return format(bytes);
}

/** UUIDv5 (RFC 9562) for deterministic operation IDs (E-03). */
export function uuidv5(namespace: string, name: string): string {
  if (!isUuid(namespace)) throw new TypeError('namespace must be a UUID');
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  return format(hash);
}
