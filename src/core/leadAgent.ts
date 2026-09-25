// Lead Agent — the autonomous "main agent" that owns a task end-to-end.
//
// It takes ONE natural-language task, decomposes it into a graph of sub-agent
// workstreams (roles + dependencies), dispatches them in parallel via the
// existing orchestrator, verifies the merged result, and RE-PLANS until the
// work is actually done or a budget is exhausted. No human interaction.
//
// Design mirrors taskConductor: the core (runLeadAgent) is provider-free and
// takes injectable seams (decompose / orchestrate / verifyOverall) so it can be
// unit-tested without a live model or a real toolchain. The default factories
// in leadAgentFactories.ts wire those seams to the real chat client, the
// orchestrator, and verifyCode. The core never touches the filesystem, a model,
// or a permission engine — persistence is an optional injected seam.

import type { WorkstreamTask, OrchestrationResult } from '../agents/orchestrator';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * A capability a sub-agent reached for but did not have. Surfaced as a
 * first-class signal (mirrors the conductor's CapabilityGap) so an autonomous
 * run reports the gap instead of silently dead-ending. The lead agent never
 * acquires the capability itself.
 */
export interface CapabilityGap {
  need: string;
  reason: string;
}

/** Verdict returned by the overall verifier for one attempt. */
export interface OverallVerdict {
  /** True when the produced work satisfies the task acceptance check. */
  passed: boolean;
  /** Human-readable reason, used to drive replanning when the check fails. */
  detail?: string;
}

/**
 * Produce a sub-agent workstream graph for the task. On attempt 1 this is the
 * initial plan; on later attempts `priorFailures` carries the reasons the
 * previous attempt did not pass, so the seam can replan around the gaps.
 * Returning an empty array means "no runnable plan".
 */
export type Decomposer = (
  task: string,
  attempt: number,
  priorFailures: string[],
) => Promise<WorkstreamTask[]>;

/** Dispatch a workstream graph (the orchestrator seam). */
export type OrchestrateFn = (tasks: WorkstreamTask[]) => Promise<OrchestrationResult>;

/** Judge whether the merged output satisfies the task. */
export type OverallVerifier = (mergedOutput: string, attempt: number) => Promise<OverallVerdict>;

/** Optional persistence seam. Keeps the core free of any fs dependency. */
export type PersistFn = (name: string, data: unknown) => Promise<void>;

export type LeadAgentStatus =
  | 'completed'               // verification passed
  | 'completed_with_failures' // verification passed but some sub-agents failed
  | 'budget_exhausted'        // ran out of attempts / time without passing
  | 'stopped'                 // aborted mid-flight
  | 'no_plan';                // decomposer produced no runnable workstreams

export type LeadAgentEvent =
  | { type: 'start'; task: string; runId?: string; at: string }
  | { type: 'decompose'; attempt: number; tasks: WorkstreamTask[]; at: string }
  | { type: 'orchestrated'; attempt: number; result: OrchestrationResult; at: string }
  | { type: 'verify'; attempt: number; passed: boolean; detail?: string; at: string }
  | { type: 'replan'; attempt: number; reason: string; at: string }
  | { type: 'capability_gap'; gap: CapabilityGap; at: string }
  | { type: 'done'; status: LeadAgentStatus; attempts: number; at: string };

/** Record of a single decompose → orchestrate → verify attempt. */
export interface LeadAgentAttempt {
  attempt: number;
  tasks: WorkstreamTask[];
  orchestration: OrchestrationResult;
  verdict: OverallVerdict;
}

export interface LeadAgentOutcome {
  task: string;
  status: LeadAgentStatus;
  attempts: LeadAgentAttempt[];
  /** Merged output of the final attempt (best available result). */
  finalOutput: string;
  capabilityGaps: CapabilityGap[];
}

export interface LeadAgentOptions {
  task: string;
  decompose: Decomposer;
  orchestrate: OrchestrateFn;
  verifyOverall: OverallVerifier;
  /** Max decompose→orchestrate→verify attempts before giving up. Default 3. */
  maxAttempts?: number;
  /** Wall-clock budget for the whole run. Default 30 minutes. */
  maxDurationMs?: number;
  /** Optional artifact sink (plan.json / result.json). No-op when omitted. */
  persist?: PersistFn;
  runId?: string;
  abortSignal?: AbortSignal;
  onEvent?: (e: LeadAgentEvent) => void;
  /** Injectable clock for test determinism. */
  now?: () => number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_DURATION_MS = 30 * 60_000;

/** Omit that distributes over a union, preserving each variant's own keys. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type LeadAgentEventInput = DistributiveOmit<LeadAgentEvent, 'at'>;

// ─── Core loop ──────────────────────────────────────────────────────

/**
 * Drive a task to a verified done-state through repeated plan → parallel
 * sub-agent execution → verify → replan. Always terminates: bounded by
 * `maxAttempts` and `maxDurationMs`. Provider-free — supply the seams.
 */
export async function runLeadAgent(options: LeadAgentOptions): Promise<LeadAgentOutcome> {
  const { task, decompose, orchestrate, verifyOverall } = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const now = options.now ?? (() => Date.now());
  const emit = (e: LeadAgentEventInput): void => {
    options.onEvent?.({ ...e, at: new Date(now()).toISOString() } as LeadAgentEvent);
  };

  const startedAt = now();
  const attempts: LeadAgentAttempt[] = [];
  const capabilityGaps: CapabilityGap[] = [];
  const seenGaps = new Set<string>();
  const priorFailures: string[] = [];
  let finalOutput = '';

  emit({ type: 'start', task, runId: options.runId });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.abortSignal?.aborted) {
      return finish('stopped');
    }
    if (now() - startedAt > maxDurationMs) {
      return finish('budget_exhausted');
    }

    // ── Plan / replan ────────────────────────────────────────────────
    const tasks = await decompose(task, attempt, priorFailures);
    if (tasks.length === 0) {
      // No runnable plan on the very first attempt is terminal; later on it
      // just means the replanner gave up, so fall through to budget_exhausted.
      if (attempt === 1) return finish('no_plan');
      break;
    }
    emit({ type: 'decompose', attempt, tasks });
    await options.persist?.(`attempt-${attempt}-plan.json`, tasks);

    // ── Dispatch sub-agents ──────────────────────────────────────────
    const result = await orchestrate(tasks);
    emit({ type: 'orchestrated', attempt, result });
    finalOutput = result.merged_output ?? finalOutput;
    collectCapabilityGaps(result, capabilityGaps, seenGaps, emit);

    // ── Verify ───────────────────────────────────────────────────────
    const verdict = await verifyOverall(result.merged_output ?? '', attempt);
    emit({ type: 'verify', attempt, passed: verdict.passed, detail: verdict.detail });
    attempts.push({ attempt, tasks, orchestration: result, verdict });
    await options.persist?.(`attempt-${attempt}-result.json`, {
      tasksSucceeded: result.tasks_succeeded,
      tasksFailed: result.tasks_failed,
      verdict,
    });

    if (verdict.passed) {
      return finish(result.tasks_failed > 0 ? 'completed_with_failures' : 'completed');
    }

    // ── Prepare replan input ─────────────────────────────────────────
    const reason = buildFailureSummary(result, verdict);
    priorFailures.push(`Attempt ${attempt}: ${reason}`);
    if (attempt < maxAttempts) {
      emit({ type: 'replan', attempt, reason });
    }
  }

  return finish('budget_exhausted');

  function finish(status: LeadAgentStatus): LeadAgentOutcome {
    emit({ type: 'done', status, attempts: attempts.length });
    const outcome: LeadAgentOutcome = { task, status, attempts, finalOutput, capabilityGaps };
    void options.persist?.('outcome.json', {
      status,
      attempts: attempts.length,
      capabilityGaps,
    }).catch?.(() => {});
    return outcome;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Signature the dispatcher uses when a tool the agent asked for is unknown. */
const MISSING_TOOL_RE = /not found in tool pool|unknown tool/i;

function collectCapabilityGaps(
  result: OrchestrationResult,
  gaps: CapabilityGap[],
  seen: Set<string>,
  emit: (e: LeadAgentEventInput) => void,
): void {
  for (const r of result.results) {
    if (!r.error || !MISSING_TOOL_RE.test(r.error)) continue;
    const key = `${r.id}:${r.error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gap: CapabilityGap = {
      need: r.error,
      reason: `Workstream "${r.id}" (${r.role}) reported a missing capability.`,
    };
    gaps.push(gap);
    emit({ type: 'capability_gap', gap });
  }
}

/** Build a compact, model-friendly summary of why an attempt did not pass. */
function buildFailureSummary(result: OrchestrationResult, verdict: OverallVerdict): string {
  const parts: string[] = [];
  if (verdict.detail) parts.push(`verification: ${verdict.detail}`);
  const failed = result.results.filter((r) => !r.success);
  if (failed.length > 0) {
    const detail = failed
      .map((r) => `${r.id} (${r.role})${r.error ? `: ${r.error}` : ''}`)
      .join('; ');
    parts.push(`failed workstreams: ${detail}`);
  }
  if (parts.length === 0) parts.push('verification did not pass (no specific detail captured)');
  return parts.join(' | ').slice(0, 1500);
}
