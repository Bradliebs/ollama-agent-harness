// ─── Silent-failure sink ────────────────────────────────────────────────
//
// Centralised landing zone for promise rejections that the call site
// chose to swallow (`.catch(() => {})`). Such swallows are legitimate
// for fire-and-forget paths — e.g. an event-store append should not
// fail a user-facing route — but the previous pattern left no record
// when the swallowed error mattered (disk full, EACCES on the audit
// log, etc.). This module gives us a ring buffer that the diagnostics
// endpoint can surface, so that "silent" failures become at least
// post-hoc visible without changing the call-site semantics.
//
// Design constraints:
//  - No I/O (the sink itself must never throw / never depend on disk).
//  - Bounded memory (ring buffer, default 200 entries).
//  - Synchronous read API (the diagnostics endpoint must not block).
//  - Cheap enough to drop on the hot path of every catch().

export interface SwallowedFailure {
  /** Short label identifying the call site (e.g. "emitEvent", "saveSettingsToDisk"). */
  label: string;
  /** Stringified error message. */
  message: string;
  /** ISO timestamp the failure was recorded. */
  at: string;
  /** Optional structured context the caller passed alongside. */
  meta?: Record<string, unknown>;
}

const MAX_ENTRIES = 200;
const buffer: SwallowedFailure[] = [];

/**
 * Record a swallowed promise rejection. Always succeeds; never throws.
 * Use directly inside `.catch(...)` blocks, e.g.
 *   somePromise().catch((err) => recordSwallowed('emitEvent', err))
 */
export function recordSwallowed(label: string, error: unknown, meta?: Record<string, unknown>): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    buffer.push({ label, message, at: new Date().toISOString(), meta });
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  } catch {
    // sink-of-last-resort: must never throw
  }
}

/** Return a shallow copy of the current ring buffer, oldest first. */
export function getSwallowedFailures(): SwallowedFailure[] {
  return buffer.slice();
}

/** Total swallowed-failure count since process start (post-buffer-trim count). */
export function getSwallowedFailureCount(): number {
  return buffer.length;
}

/** Clear the buffer. Only intended for tests. */
export function _resetSwallowedFailuresForTest(): void {
  buffer.length = 0;
}
