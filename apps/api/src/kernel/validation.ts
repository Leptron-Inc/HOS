import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Boundary validation (tenancy specification F-01, CX-09): unknown fields are rejected, every
 * string has a maximum length, IDs must be UUIDs. Request bodies never carry organization_id or
 * property_id; a strict object rejects them as unknown fields (H-CTX-06).
 */
export const uuid = () =>
  z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'must be a lowercase UUID',
    );
export const text = (max: number, min = 1) => z.string().min(min).max(max);
export const code = () =>
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 letters, digits, - or _');

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(
    result.error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.map(String).join('.') || '(body)',
      // zod messages describe the rule, never echo the submitted value.
      message:
        issue.code === 'unrecognized_keys'
          ? `unknown field(s): ${(issue as { keys?: string[] }).keys?.join(', ') ?? ''}`
          : issue.message,
    })),
  );
}

/** E-19: If-Match carries the version as a quoted ETag ("7"). */
export function versionFromIfMatch(header: string | undefined): number | null {
  if (header === undefined || header === '') return null;
  const match = /^(?:W\/)?"(\d{1,15})"$/.exec(header.trim());
  if (!match)
    throw new ValidationError([{ path: 'If-Match', message: 'must be the ETag of the resource' }]);
  return Number(match[1]);
}

export function etag(version: number): string {
  return `"${version}"`;
}

export { z };
