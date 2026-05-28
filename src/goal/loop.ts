// Active Goal outer loop.
//
// This is the orchestrator that drives a Goal through iterations until it
// reaches a terminal state. It is intentionally agnostic about HOW each
// iteration does its work — the caller supplies a `runIteration` callback.
// That keeps this module independent of queryLoop, the dispatcher, the
// chat client, and the web server. A trivial caller might just run
// `npm test` once per iteration; a real caller invokes a full queryLoop
// session.
//
// Responsibilities:
//   * enforce iteration / time budgets from goal constraints
//   * re-read goal status between iterations so external pause/abandon wins
//   * run verification before iteration 1 (skip work if already satisfied)
//   * run verification after each iteration; complete on all-required-pass
//   * persist each iteration via updateGoal so progress survives a crash

import { Goal, isTerminal } from './types';
import { readGoal, transitionGoal, updateGoal } from './store';
import { runAllChecks, type RunCheckContext, type BatchResult } from './verification';
import { extractBudget } from './loopConfig';

/** Default outer-loop cap when the goal has no `budget` constraint. */
export const DEFAULT_MAX_ITERATIONS = 25;

/** Returned by the caller for each iteration. */
export interface IterationOutcome {
  /** One-line summary of what the iteration did. */
  action: string;
  toolCalls?: number;
  filesTouched?: string[];
  tokensUsed?: number;
  notes?: string;
  /** Git SHAs the iteration produced, if any. */
  commits?: string[];
  /** Populate when the runner itself errored. The loop will record the iteration but keep going. */
  error?: string;
}

export type GoalLoopReason =
  | 'already_satisfied'    // initial verification passed; no iterations run
  | 'success'              // verification passed after one or more iterations
  | 'iteration_budget'     // out of iterations without passing
  | 'time_budget'          // wall-clock exceeded
  | 'externally_paused'    // pause / abandon detected mid-flight
  | 'externally_blocked'
  | 'externally_abandoned'
  | 'goal_missing'         // goal disappeared from store
  | 'not_runnable';        // goal is in a state the loop cannot drive

export type GoalLoopEvent =
  | { type: 'loop_start'; goalId: string; budget: ReturnType<typeof extractBudget>; at: string }
  | { type: 'verification_start'; goalId: string; iteration: number; at: string }
  | { type: 'verification_end'; goalId: string; iteration: number; result: BatchResult; at: string }
  | { type: 'iteration_start'; goalId: string; iteration: number; at: string }
  | { type: 'iteration_end'; goalId: string; iteration: number; outcome: IterationOutcome; at: string }
  | { type: 'transitioned'; goalId: string; from: Goal['status']; to: Goal['status']; at: string }
  | { type: 'loop_end'; goalId: string; reason: GoalLoopReason; iterations: number; at: string };

export interface RunGoalLoopDeps {
  projectDir: string;
  goalId: string;
  /** Caller-supplied work for one iteration. The loop never invokes any agent itself. */
  runIteration: (goal: Goal, iterationN: number) => Promise<IterationOutcome>;
  /** Forwarded to runAllChecks for model_judge / http checks. */
  verifyCtx?: Omit<RunCheckContext, 'goalTarget'>;
  /** Inject for test determinism. */
  now?: () => Date;
  /** Outer-loop cap when the goal has no `budget` constraint. */
  defaultMaxIterations?: number;
  /** Stop iterating early. The loop yields `loop_end` with reason `externally_paused`. */
  abortSignal?: AbortSignal;
}

export async function* runGoalLoop(deps: RunGoalLoopDeps): AsyncGenerator<GoalLoopEvent> {
  const { projectDir, goalId, runIteration, verifyCtx, abortSignal } = deps;
  const now = deps.now ?? (() => new Date());
  const defaultMax = deps.defaultMaxIterations ?? DEFAULT_MAX_ITERATIONS;

  // ── Hydration ─────────────────────────────────────────────────────────
  let goal = await readGoal(projectDir, goalId);
  if (!goal) {
    yield { type: 'loop_end', goalId, reason: 'goal_missing', iterations: 0, at: now().toISOString() };
    return;
  }
  if (isTerminal(goal.status)) {
    yield { type: 'loop_end', goalId, reason: 'not_runnable', iterations: 0, at: now().toISOString() };
    return;
  }
  if (goal.status === 'paused' || goal.status === 'blocked') {
    yield {
      type: 'loop_end',
      goalId,
      reason: goal.status === 'paused' ? 'externally_paused' : 'externally_blocked',
      iterations: 0,
      at: now().toISOString(),
    };
    return;
  }

  // draft → active is the loop's responsibility.
  if (goal.status === 'draft') {
    goal = await transitionGoal(projectDir, goalId, 'active', {}, now());
    yield { type: 'transitioned', goalId, from: 'draft', to: 'active', at: now().toISOString() };
  }

  const budget = extractBudget(goal);
  const maxIterations = budget.maxIterations ?? defaultMax;
  const startedAtMs = now().getTime();
  yield { type: 'loop_start', goalId, budget, at: new Date(startedAtMs).toISOString() };

  // ── Initial verification ──────────────────────────────────────────────
  // If the goal is already satisfied, skip work entirely. Always persist
  // the initial check history so the evidence trail captures every run,
  // not just the runs that flipped a status.
  const initial = await runVerification(goal, 0, verifyCtx, now);
  yield initial.start;
  yield initial.end;
  await persistCheckHistory(projectDir, goalId, goal, initial.result, now);
  if (initial.result.allRequiredPassed) {
    await transitionGoal(projectDir, goalId, 'complete', {}, now());
    yield { type: 'transitioned', goalId, from: 'active', to: 'complete', at: now().toISOString() };
    yield { type: 'loop_end', goalId, reason: 'already_satisfied', iterations: 0, at: now().toISOString() };
    return;
  }

  // ── Iteration loop ────────────────────────────────────────────────────
  let n = 0;
  while (n < maxIterations) {
    if (abortSignal?.aborted) {
      yield { type: 'loop_end', goalId, reason: 'externally_paused', iterations: n, at: now().toISOString() };
      return;
    }

    // Time budget check.
    if (budget.maxDurationMs !== undefined && now().getTime() - startedAtMs > budget.maxDurationMs) {
      await transitionGoal(projectDir, goalId, 'failed', {}, now());
      yield { type: 'transitioned', goalId, from: 'active', to: 'failed', at: now().toISOString() };
      yield { type: 'loop_end', goalId, reason: 'time_budget', iterations: n, at: now().toISOString() };
      return;
    }

    // Re-read goal each iteration so external pause / abandon wins.
    const fresh = await readGoal(projectDir, goalId);
    if (!fresh) {
      yield { type: 'loop_end', goalId, reason: 'goal_missing', iterations: n, at: now().toISOString() };
      return;
    }
    if (fresh.status !== 'active') {
      yield {
        type: 'loop_end',
        goalId,
        reason: externalReason(fresh.status),
        iterations: n,
        at: now().toISOString(),
      };
      return;
    }
    goal = fresh;

    n += 1;

    // Run iteration.
    yield { type: 'iteration_start', goalId, iteration: n, at: now().toISOString() };
    const itStartedAt = now();
    let outcome: IterationOutcome;
    try {
      outcome = await runIteration(goal, n);
    } catch (err) {
      // The contract says runners should not throw, but if they do we
      // capture the error as iteration evidence rather than crashing the loop.
      outcome = {
        action: 'iteration runner threw',
        notes: 'see error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const itEndedAt = now();

    await persistIteration(projectDir, goalId, n, itStartedAt, itEndedAt, outcome, now);
    yield { type: 'iteration_end', goalId, iteration: n, outcome, at: itEndedAt.toISOString() };

    // Verification after the iteration.
    const verif = await runVerification(goal, n, verifyCtx, now);
    yield verif.start;
    yield verif.end;
    await persistCheckHistory(projectDir, goalId, goal, verif.result, now);

    if (verif.result.allRequiredPassed) {
      await transitionGoal(projectDir, goalId, 'complete', {}, now());
      yield { type: 'transitioned', goalId, from: 'active', to: 'complete', at: now().toISOString() };
      yield { type: 'loop_end', goalId, reason: 'success', iterations: n, at: now().toISOString() };
      return;
    }
  }

  // Out of iterations.
  await transitionGoal(projectDir, goalId, 'failed', {}, now());
  yield { type: 'transitioned', goalId, from: 'active', to: 'failed', at: now().toISOString() };
  yield { type: 'loop_end', goalId, reason: 'iteration_budget', iterations: n, at: now().toISOString() };
}

// ── Internal helpers ─────────────────────────────────────────────────────

function externalReason(status: Goal['status']): GoalLoopReason {
  if (status === 'paused') return 'externally_paused';
  if (status === 'blocked') return 'externally_blocked';
  if (status === 'abandoned') return 'externally_abandoned';
  return 'not_runnable';
}

async function runVerification(
  goal: Goal,
  iteration: number,
  verifyCtx: Omit<RunCheckContext, 'goalTarget'> | undefined,
  now: () => Date,
): Promise<{ start: GoalLoopEvent; end: GoalLoopEvent; result: BatchResult }> {
  const ctx: RunCheckContext = { ...verifyCtx, goalTarget: goal.target };
  const start: GoalLoopEvent = { type: 'verification_start', goalId: goal.id, iteration, at: now().toISOString() };
  const result = await runAllChecks(goal.verification, ctx);
  const end: GoalLoopEvent = { type: 'verification_end', goalId: goal.id, iteration, result, at: now().toISOString() };
  return { start, end, result };
}

async function persistIteration(
  projectDir: string,
  goalId: string,
  n: number,
  startedAt: Date,
  endedAt: Date,
  outcome: IterationOutcome,
  now: () => Date,
): Promise<void> {
  await updateGoal(projectDir, goalId, (g) => {
    g.iterations.push({
      n,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      action: outcome.action,
      toolCalls: outcome.toolCalls ?? 0,
      // verificationsRun/Passed are written by persistCheckHistory; record 0 here
      // and the next verification pass will record its own check history entries.
      verificationsRun: 0,
      verificationsPassed: 0,
      filesTouched: outcome.filesTouched ?? [],
      tokensUsed: outcome.tokensUsed,
      notes: outcome.error ? `error: ${outcome.error}${outcome.notes ? ' | ' + outcome.notes : ''}` : (outcome.notes ?? ''),
    });
    for (const f of outcome.filesTouched ?? []) {
      if (!g.evidence.files.includes(f)) g.evidence.files.push(f);
    }
    for (const c of outcome.commits ?? []) {
      if (!g.evidence.commits.includes(c)) g.evidence.commits.push(c);
    }
    return g;
  }, now());
}

async function persistCheckHistory(
  projectDir: string,
  goalId: string,
  goal: Goal,
  batch: BatchResult,
  now: () => Date,
): Promise<void> {
  await updateGoal(projectDir, goalId, (g) => {
    // Update last iteration row with verification totals if present.
    if (g.iterations.length > 0) {
      const last = g.iterations[g.iterations.length - 1];
      last.verificationsRun = batch.results.length;
      last.verificationsPassed = batch.results.filter((r) => r.result.passed).length;
    }
    // Mirror check.lastResult and append to history.
    for (const { check, result } of batch.results) {
      const slot = g.verification.find((c) => c.id === check.id);
      if (slot) slot.lastResult = result;
      g.evidence.checkHistory.push({ checkId: check.id, result });
    }
    void goal; // referenced for symmetry; mutation is on the cloned `g`.
    return g;
  }, now());
}
