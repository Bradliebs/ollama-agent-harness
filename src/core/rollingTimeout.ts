// Inactivity timeouts for long-running async work.
//
// `withTimeout` is a flat per-operation timeout: fixed deadline from the call.
// `withRollingTimeout` resets the deadline every time the caller fires a
// heartbeat — useful when wrapping a generator/stream consumer where each
// yielded event is evidence the work is still alive.
//
// Both reject with `InactivityTimeoutError` so callers can distinguish a
// timeout from a model error or a manual abort.
//
// Ported from Microsoft Scout's `electron/ipc/with-timeout.ts`.

export class InactivityTimeoutError extends Error {
  readonly inactivityMs: number;
  readonly kind: 'flat' | 'rolling';
  constructor(ms: number, kind: 'flat' | 'rolling') {
    super(
      kind === 'rolling'
        ? `Operation timed out after ${ms}ms of inactivity`
        : `Operation timed out after ${ms}ms`,
    );
    this.name = 'InactivityTimeoutError';
    this.inactivityMs = ms;
    this.kind = kind;
  }
}

/**
 * Race `operation` against a flat timeout. Rejects with
 * `InactivityTimeoutError` when the operation does not settle within `ms`.
 * The timer is cleared on settle either way; the orphan operation's
 * unhandled-rejection is suppressed when the timeout wins.
 */
export function withTimeout<T>(ms: number, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = operation.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  const result = Promise.race([
    wrapped,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new InactivityTimeoutError(ms, 'flat')), ms);
    }),
  ]);
  wrapped.catch(() => { /* suppress unhandled rejection when timeout wins */ });
  return result;
}

/**
 * Like `withTimeout`, but the timer resets every time `heartbeat()` is
 * called. The caller's `start` builds the operation promise and is handed
 * the `heartbeat` function — fire it on each progress signal (token chunk,
 * tool event, etc.) to keep the deadline pushed back.
 *
 * `cleanup` runs on success, error, and timeout, so callers can release
 * subscriptions / abort children without bookkeeping.
 */
export function withRollingTimeout<T>(
  ms: number,
  start: (heartbeat: () => void) => { promise: Promise<T>; cleanup?: () => void },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let settled = false;

  return new Promise<T>((resolve, reject) => {
    const fail = () => {
      if (settled) return;
      settled = true;
      ctx.cleanup?.();
      reject(new InactivityTimeoutError(ms, 'rolling'));
    };

    const resetTimer = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(fail, ms);
    };

    const ctx = start(resetTimer);

    // Arm the initial deadline. setTimeout is a macrotask so `fail` can
    // safely reference `ctx` — it is always assigned before any timer
    // callback can fire.
    resetTimer();
    ctx.promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ctx.cleanup?.();
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ctx.cleanup?.();
          reject(err);
        }
      },
    );
  });
}
