import { AsyncLocalStorage } from 'node:async_hooks';
import { currentContext } from '../../../kernel/public.js';
import type { AuthorizationTarget, PrincipalGrants } from './grants.js';

/**
 * Request-scoped authorization (CX-07, F-16). The trusted entry point evaluates the principal's
 * grants once and runs the unit of work with them; every module authorizes its own actions with
 * `requirePermission`, and never assumes a caller already checked.
 */
export class PermissionDeniedError extends Error {
  constructor(
    readonly permission: string,
    readonly target: AuthorizationTarget,
  ) {
    super(`permission ${permission} denied`);
    this.name = 'PermissionDeniedError';
  }
}

const storage = new AsyncLocalStorage<PrincipalGrants>();

export function runWithGrants<T>(grants: PrincipalGrants, work: () => Promise<T>): Promise<T> {
  return storage.run(grants, work);
}

function grantsForCurrentContext(): PrincipalGrants {
  const grants = storage.getStore();
  const ctx = currentContext();
  if (
    grants === undefined ||
    grants.actorId !== ctx.actor.id ||
    grants.organizationId !== ctx.tenant.organizationId
  ) {
    throw new PermissionDeniedError('(no evaluated grants)', {});
  }
  return grants;
}

export function hasPermission(permission: string, target: AuthorizationTarget = {}): boolean {
  return grantsForCurrentContext().allows(permission, target);
}

/** Throws PermissionDeniedError; the entry point records the denial and answers 403 (H-DEPT-02). */
export function requirePermission(permission: string, target: AuthorizationTarget = {}): void {
  if (!hasPermission(permission, target)) throw new PermissionDeniedError(permission, target);
}
