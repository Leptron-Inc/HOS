/** Classifies PostgreSQL errors by SQLSTATE without exposing driver types to modules. */
export function isDatabaseError(error: unknown, code?: string): error is Error & { code: string } {
  const value = (error as { code?: unknown } | null)?.code;
  return (
    typeof value === 'string' &&
    /^[0-9A-Z]{5}$/.test(value) &&
    (code === undefined || value === code)
  );
}

export const isUniqueViolation = (error: unknown): boolean => isDatabaseError(error, '23505');
export const isForeignKeyViolation = (error: unknown): boolean => isDatabaseError(error, '23503');
export const isPermissionDenied = (error: unknown): boolean => isDatabaseError(error, '42501');
export const isLockTimeout = (error: unknown): boolean => isDatabaseError(error, '55P03');
