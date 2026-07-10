// Run Reverter — executes the compensating actions planned by the side-effect
// ledger, actually undoing a run's filesystem changes.
//
// `planRunReversal` (in sideEffectLedger) decides WHAT to undo and in what
// order; this module DOES it: restore_file rewrites prior content, delete_file
// removes a created path. Each successfully compensated effect is then marked
// reversed in the ledger so a repeat undo is a no-op. Irreversible effects
// (a sent message, a network call) are surfaced, never silently skipped, and a
// failed compensation does not mark the effect reversed — so it can be retried.

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  listSideEffects,
  markSideEffectReversed,
  planRunReversal,
  type SideEffect,
} from './sideEffectLedger';

export interface RunRevertResult {
  runId: string;
  /** Effects whose compensating action succeeded and were marked reversed. */
  reverted: SideEffect[];
  /** Effects whose compensating action threw; left un-reversed for retry. */
  failed: { effect: SideEffect; error: string }[];
  /** Effects that cannot be undone (e.g. a sent notification) — reported only. */
  irreversible: SideEffect[];
  /** Effects already reverted on a prior undo — untouched. */
  alreadyReversed: SideEffect[];
}

/** Resolve a recorded (possibly workspace-relative) path against the project dir. */
function resolvePath(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(projectDir, p);
}

async function applyReversal(projectDir: string, effect: SideEffect): Promise<void> {
  const r = effect.reversal;
  switch (r.kind) {
    case 'restore_file': {
      const fp = resolvePath(projectDir, r.path);
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.writeFile(fp, r.previousContent, 'utf-8');
      return;
    }
    case 'delete_file': {
      const fp = resolvePath(projectDir, r.path);
      try {
        await fs.unlink(fp);
      } catch (err) {
        // Already gone is the desired end state, not a failure.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    case 'irreversible':
      // Should never reach here — planRunReversal buckets these separately.
      throw new Error(`cannot revert irreversible effect: ${r.reason}`);
  }
}

/**
 * Undo every reversible side effect of a run, in reverse-chronological order.
 * Effects are reverted most-recent-first so a create-then-modify of the same
 * path unwinds correctly. Continues past individual failures and reports them.
 */
export async function revertRun(projectDir: string, runId: string): Promise<RunRevertResult> {
  const effects = await listSideEffects(projectDir);
  const plan = planRunReversal(runId, effects);

  const reverted: SideEffect[] = [];
  const failed: { effect: SideEffect; error: string }[] = [];

  for (const effect of plan.toReverse) {
    try {
      await applyReversal(projectDir, effect);
      await markSideEffectReversed(projectDir, effect.id);
      reverted.push(effect);
    } catch (err) {
      failed.push({ effect, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    runId,
    reverted,
    failed,
    irreversible: plan.irreversible,
    alreadyReversed: plan.alreadyReversed,
  };
}
