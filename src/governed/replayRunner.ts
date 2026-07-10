// Governed Agent Loop — replay runner.
//
// Closes the last open link of the loop. A human drains a needs-review answer
// onto the replay seam; this runner consumes those candidates, re-asks each one
// through an injected harness runner, and re-enqueues the fresh governed answer
// for human review. It writes nothing to the brain and auto-approves nothing —
// a replayed answer re-enters the same human-gated review queue, so the loop is
// "shadow first, behavior later" end-to-end.
//
// The runner is injectable (runOne + enqueue) so it stays model-free and
// testable; the web server supplies the real harness runner at the route.

import type { GovernedAnswer } from './governedAnswer';
import type { ReplayCandidate } from './replayConsumer';
import { consumeReplayCandidates } from './replayConsumer';
import { enqueueFromGoverned } from './reviewQueue';
import { logger } from '../core/logger';

export interface ReplayRunResult {
  /** Candidates drained from the seam (consumed exactly once). */
  consumed: number;
  /** Candidates that completed a replay run (governed or not). */
  replayed: number;
  /** Fresh governed answers re-entered into the human-gated review queue. */
  reQueued: number;
}

export interface RunReplayOptions {
  /** Re-asks one drained candidate through the harness; null = no governed answer produced. */
  runOne: (candidate: ReplayCandidate) => Promise<GovernedAnswer | null>;
  /** Re-enters a fresh governed answer into the human-gated review queue, carrying the original for a before/after view. */
  enqueue?: (governed: GovernedAnswer, candidate: ReplayCandidate) => unknown;
}

/**
 * Consume the drained replay candidates and re-run each through the harness,
 * re-enqueuing any fresh governed answer for human review. Per-candidate
 * failures are logged, not thrown, so one bad replay never blocks the rest.
 */
export async function runReplayCandidates(options: RunReplayOptions): Promise<ReplayRunResult> {
  const enqueue =
    options.enqueue ??
    ((governed: GovernedAnswer, candidate: ReplayCandidate) =>
      enqueueFromGoverned(governed, { replayOf: candidate.id, priorContent: candidate.content }));
  const candidates = await consumeReplayCandidates();
  let replayed = 0;
  let reQueued = 0;
  for (const candidate of candidates) {
    let governed: GovernedAnswer | null = null;
    try {
      governed = await options.runOne(candidate);
    } catch (err) {
      logger.warn('ReplayRunner', 'Replay run failed for candidate', {
        id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    replayed++;
    if (!governed) continue;
    try {
      enqueue(governed, candidate);
      reQueued++;
    } catch (err) {
      logger.warn('ReplayRunner', 'Re-enqueue failed for candidate', {
        id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { consumed: candidates.length, replayed, reQueued };
}
