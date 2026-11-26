/**
 * Domain errors that modules throw. The HTTP entry point maps them to problem details (F-03);
 * workers map them to retry or dead-letter decisions. Messages never contain personal values,
 * other tenants' identifiers or internal detail (F-05).
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(readonly errors: readonly { readonly path: string; readonly message: string }[]) {
    super('validation failed');
  }
}

/** Not found, or not authorized to know it exists (CX-08). */
export class NotFoundError extends DomainError {
  constructor() {
    super('not found');
  }
}

export class VersionConflictError extends DomainError {
  constructor(readonly currentVersion?: number) {
    super('version conflict');
  }
}

/** A business transition that isn't allowed; `code` is namespaced `<module>.<code>` (F-04). */
export class StateConflictError extends DomainError {
  constructor(readonly code: string) {
    super(code);
  }
}

export class PreconditionRequiredError extends DomainError {
  constructor() {
    super('If-Match is required');
  }
}

export class IdempotencyKeyReuseError extends DomainError {
  constructor() {
    super('idempotency key reused for a different request');
  }
}

export class IdempotencyInProgressError extends DomainError {
  constructor() {
    super('idempotency key in progress');
  }
}

/** A tenant value in the payload contradicts the context (CX-09); logged as context_mismatch. */
export class ContextMismatchError extends DomainError {
  constructor(
    readonly reason:
      'payload_tenant_mismatch' | 'payload_property_mismatch' | 'webhook_account_mismatch',
  ) {
    super('context mismatch');
  }
}

export class DependencyUnavailableError extends DomainError {
  constructor(readonly dependency: string) {
    super(`${dependency} unavailable`);
  }
}
