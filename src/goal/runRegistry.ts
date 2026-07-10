// In-process registry of running goal loops.
//
// Each goal can have at most one in-flight loop per process. The registry
// holds the AbortController so /pause and /abandon endpoints can interrupt
// the loop without waiting for the next iteration to discover the disk
// status change. Stops are cooperative; the loop still checks aborted
// between iterations and treats it as externally_paused.

export interface RegisteredRun {
  abort: AbortController;
  startedAt: Date;
}

const runs = new Map<string, RegisteredRun>();

export function registerRun(goalId: string): AbortController {
  const existing = runs.get(goalId);
  if (existing) {
    throw new Error(`registerRun: goal '${goalId}' already has an active run`);
  }
  const abort = new AbortController();
  runs.set(goalId, { abort, startedAt: new Date() });
  return abort;
}

export function unregisterRun(goalId: string): void {
  runs.delete(goalId);
}

export function abortRun(goalId: string): boolean {
  const run = runs.get(goalId);
  if (!run) return false;
  run.abort.abort();
  return true;
}

export function isRunning(goalId: string): boolean {
  return runs.has(goalId);
}

export function listRunning(): Array<{ goalId: string; startedAt: Date }> {
  return [...runs.entries()].map(([goalId, run]) => ({ goalId, startedAt: run.startedAt }));
}

/** Test hook. */
export function _resetRunRegistryForTest(): void {
  for (const run of runs.values()) {
    try { run.abort.abort(); } catch { /* ignore */ }
  }
  runs.clear();
}
