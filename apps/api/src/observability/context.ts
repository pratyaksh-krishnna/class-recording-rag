import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Identifiers carried through a single request so every log line correlates
 * without threading a logger argument through every function (spec §20).
 * Content — questions, answers, chunk text — is deliberately absent.
 */
export interface RequestContext {
  requestId: string;
  conversationId?: string;
  userId?: string;
  cohortId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
