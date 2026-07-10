// Resume support for the Active Goal loop.
//
// On harness boot, we want to know: is there a goal the user was working on,
// and if so, what state is it in? UI / startup code decides whether to
// auto-resume (e.g. an active goal that was mid-flight when the process
// crashed) or surface a prompt (e.g. a paused goal needs an explicit ack).

import { Goal } from './types';
import { getActiveGoal, readGoal, transitionGoal } from './store';

export type ResumeKind =
  | 'auto'        // active or blocked-pending — caller should be willing to resume without confirmation
  | 'needs_ack'   // paused by a human — should not silently restart
  | 'none';       // no resumable goal

export interface ResumableGoal {
  goal: Goal;
  kind: ResumeKind;
}

/**
 * Returns the active goal (if any) tagged with how the caller should treat it.
 *
 * - `active`              → kind: 'auto'        (crashed mid-flight; safe to resume)
 * - `blocked`             → kind: 'needs_ack'   (loop wedged; need human input)
 * - `paused`              → kind: 'needs_ack'   (human pressed pause; ask before restarting)
 * - draft / terminal      → not surfaced
 */
export async function getResumableGoal(projectDir: string): Promise<ResumableGoal | { kind: 'none' }> {
  const goal = await getActiveGoal(projectDir);
  if (!goal) return { kind: 'none' };
  switch (goal.status) {
    case 'active':
      return { goal, kind: 'auto' };
    case 'paused':
    case 'blocked':
      return { goal, kind: 'needs_ack' };
    default:
      return { kind: 'none' };
  }
}

/**
 * Move a paused goal back to active. Rejects if the goal is in any other
 * state; callers must use `transitionGoal` directly for non-resume flows.
 */
export async function resumeGoal(projectDir: string, goalId: string, now: Date = new Date()): Promise<Goal> {
  const current = await readGoal(projectDir, goalId);
  if (!current) throw new Error(`resumeGoal: goal not found: ${goalId}`);
  if (current.status !== 'paused') {
    throw new Error(`resumeGoal: goal is in state '${current.status}', expected 'paused'`);
  }
  return transitionGoal(projectDir, goalId, 'active', { pause: undefined }, now);
}
