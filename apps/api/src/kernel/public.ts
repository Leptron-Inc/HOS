/**
 * The kernel's public surface for modules (module map §7.1 layers L0 and L1; tenancy specification
 * F-15). Modules import only this file (and kernel/database/public.ts re-exported here); kernel
 * internals, the context factory and raw connections stay inside the kernel (.dependency-cruiser.cjs).
 */
export * from './database/public.js';
export { currentContext, currentContextOrUndefined } from './context/context-store.js';
export {
  ContextMissingError,
  type ActorId,
  type ActorRealm,
  type DepartmentId,
  type EntryPoint,
  type OrganizationId,
  type PropertyId,
  type PropertyScope,
  type RequestContext,
  type VerifiedActor,
} from './context/request-context.js';
export { appendAudit, AuditRedactionError, type AuditEntry } from './audit/audit-writer.js';
export {
  defineEvent,
  eventContract,
  EventContractError,
  type EventContract,
  type EventEnvelope,
} from './outbox/event-contracts.js';
export { publishEvent, type PublishOptions } from './outbox/outbox-writer.js';
export {
  IdempotencyStore,
  requestFingerprint,
  type AcquireResult,
  type IdempotentRequest,
  type StoredResponse,
  type WriteResult,
} from './idempotency/idempotency-store.js';
export {
  decodeCursor,
  encodeCursor,
  pageLimit,
  toPage,
  MAX_PAGE_LIMIT,
  type CursorPosition,
  type Page,
} from './pagination.js';
export { code, etag, parse, text, uuid, versionFromIfMatch, z } from './validation.js';
export { Logger, errorFields, redactValue } from './observability/logger.js';
export {
  eraseHistory,
  listAuditRecords,
  verifyTenantAuditChain,
  type AuditRecordView,
} from './audit/audit-reader.js';
export type { ChainVerification } from './audit/audit-writer.js';
export {
  listDeadLetters,
  requestDeadLetterReplay,
  type DeadLetterView,
} from './outbox/dead-letters.js';
export { defineSubscription, type Subscription } from './outbox/subscriptions.js';
export { MetricsRegistry } from './observability/metrics.js';
export { isUuid, uuidv5, uuidv7 } from './ids.js';
export {
  ContextMismatchError,
  DependencyUnavailableError,
  DomainError,
  IdempotencyInProgressError,
  IdempotencyKeyReuseError,
  NotFoundError,
  PreconditionRequiredError,
  StateConflictError,
  ValidationError,
  VersionConflictError,
} from './errors.js';
