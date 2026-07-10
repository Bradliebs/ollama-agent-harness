import { AsyncLocalStorage } from 'async_hooks';

// Per-async-context session id, used to stamp provenance on side effects (e.g.
// memory writes) without threading a parameter through the static Tool.execute
// contract. AsyncLocalStorage scopes the value to the call tree of whoever set
// it, so concurrent sessions (subagents, squads) never see each other's id —
// the failure mode a process-global env var would have. Absent context => no
// session id (never a wrong one).
const sessionStore = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `sessionId` bound as the current session for the duration of
 * its (possibly async) execution. When `sessionId` is undefined, `fn` runs with
 * no binding so `getCurrentSessionId()` falls through to its other sources.
 */
export function runWithSessionId<T>(sessionId: string | undefined, fn: () => T): T {
  if (!sessionId) return fn();
  return sessionStore.run(sessionId, fn);
}

/** The session id bound for the current async context, if any. */
export function getCurrentSessionId(): string | undefined {
  return sessionStore.getStore();
}
