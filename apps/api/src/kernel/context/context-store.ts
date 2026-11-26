import { AsyncLocalStorage } from 'node:async_hooks';
import { ContextMissingError, type RequestContext } from './request-context.js';

/**
 * Holds the context of the current unit of work in async-local storage (CX-02). There is no
 * setter: a unit of work runs under exactly one context, and work for a different tenant or actor
 * is a new unit of work (for example an enqueued job).
 */
const storage = new AsyncLocalStorage<RequestContext>();

/** Runs one unit of work under a context. Switching to a different context inside one is refused. */
export function runWithContext<T>(context: RequestContext, work: () => Promise<T>): Promise<T> {
  if (
    !Object.isFrozen(context) ||
    !Object.isFrozen(context.tenant) ||
    !Object.isFrozen(context.actor)
  ) {
    throw new ContextMissingError('context was not created by the context factory');
  }
  const existing = storage.getStore();
  if (existing !== undefined && existing !== context) {
    throw new ContextMissingError(
      'a unit of work cannot switch context; enqueue a new unit of work instead',
    );
  }
  return storage.run(context, work);
}

/** The current unit of work's context; throws (fail closed) outside a unit of work. */
export function currentContext(): RequestContext {
  const context = storage.getStore();
  if (context === undefined) throw new ContextMissingError('no unit of work is active');
  return context;
}

export function currentContextOrUndefined(): RequestContext | undefined {
  return storage.getStore();
}
