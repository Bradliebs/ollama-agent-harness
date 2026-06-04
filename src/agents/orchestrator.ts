// Subagent Orchestrator — parallel execution, budgets, isolation, and result merging.
//
// Extends the existing runSubagent() with:
// - Parallel workstream execution (fan-out / fan-in)
// - Per-agent budgets (max turns, max time)
// - Agent roles with preset configurations
// - Result merging and conflict detection
// - Loop detection across parallel agents

import type { Tool } from '../types';
import type { IChatClient } from '../core/chatClient';
import { runSubagent, type SubagentConfig } from './subagent';
import { verifyCode, type VerificationStatus } from '../core/doneStateVerifier';
import { planVerifiedMerge, type BranchVerification } from './verifiedMerge';

// ─── Types ──────────────────────────────────────────────────────────

export type AgentRole =
  | 'planner'
  | 'researcher'
  | 'coder'
  | 'debugger'
  | 'reviewer'
  | 'critic'
  | 'summariser'
  | 'tool_executor'
  | 'service_operator'
  | 'safety_checker'
  | 'context_compressor';

export interface AgentBudget {
  maxTurns: number;
  maxTimeMs: number;
}

export interface WorkstreamTask {
  id: string;
  role: AgentRole;
  prompt: string;
  /** Override budget for this task. */
  budget?: Partial<AgentBudget>;
  /** Dependencies: task ids that must complete first. */
  dependsOn?: string[];
}

export interface WorkstreamResult {
  id: string;
  role: AgentRole;
  output: string;
  success: boolean;
  duration_ms: number;
  error?: string;
  /**
   * Verification verdict for this branch's work, if one was produced. Distinct
   * from `success`, which only means the branch ran to completion. The verified
   * merge path (mergeVerified) gates on this, not on `success`.
   */
  verification?: VerificationStatus;
}

export interface OrchestrationResult {
  results: WorkstreamResult[];
  merged_output?: string;
  total_duration_ms: number;
  tasks_succeeded: number;
  tasks_failed: number;
}

// ─── Branch verification ──────────────────────────────────

/**
 * Produces a verification verdict for a completed branch, or undefined when the
 * branch's work cannot be judged. Injected so the verdict is earned by a real
 * check rather than assumed — the caller decides how a branch is proven.
 */
export type BranchVerifier = (
  result: WorkstreamResult,
  projectDir?: string,
) => Promise<VerificationStatus | undefined>;

/**
 * Attach a verification verdict to a branch result, if a verifier is supplied.
 * Only completed branches are verified — a failed/empty branch has nothing to
 * verify and won't merge regardless. A verifier that returns undefined or throws
 * leaves the verdict absent: "proof unobtainable" is not "verified pass", so the
 * branch stays unmergeable under mergeVerified. Verification never crashes a branch.
 */
export async function attachVerification(
  result: WorkstreamResult,
  verify: BranchVerifier | undefined,
  projectDir?: string,
): Promise<WorkstreamResult> {
  if (!verify || !result.success) return result;
  try {
    const verification = await verify(result, projectDir);
    return verification ? { ...result, verification } : result;
  } catch {
    return result;
  }
}

const CODE_PRODUCING_ROLES: ReadonlySet<AgentRole> = new Set(['coder', 'debugger']);

/**
 * Opt-in default BranchVerifier: runs the real code verifier against projectDir
 * for code-producing roles only. Returns undefined — no verdict — for non-code
 * roles or when no projectDir is available, so verdicts are never fabricated for
 * work the verifier cannot actually judge. NOTE: verifyCode inspects repository
 * state, not an isolated per-branch diff; use with sandboxed branches (or
 * sequential code branches) for the verdict to attribute to a single branch.
 */
export const verifyCodeBranch: BranchVerifier = async (result, projectDir) => {
  if (!projectDir || !CODE_PRODUCING_ROLES.has(result.role)) return undefined;
  const verification = await verifyCode({ projectDir, quick: true });
  return verification.overall;
};

// ─── Role presets ───────────────────────────────────────────────────

const ROLE_DEFAULTS: Record<AgentRole, { systemPrompt: string; budget: AgentBudget }> = {
  planner: {
    systemPrompt: 'You are a planning agent. Break down the task into clear, actionable steps. Do not execute — only plan.',
    budget: { maxTurns: 5, maxTimeMs: 60_000 },
  },
  researcher: {
    systemPrompt: 'You are a research agent. Find relevant information using available tools. Summarize findings concisely.',
    budget: { maxTurns: 8, maxTimeMs: 120_000 },
  },
  coder: {
    systemPrompt: 'You are a coding agent. Write clean, minimal code that solves the problem. Follow existing project conventions.',
    budget: { maxTurns: 15, maxTimeMs: 180_000 },
  },
  debugger: {
    systemPrompt: 'You are a debugging agent. Diagnose the issue, identify root cause, and propose a fix.',
    budget: { maxTurns: 10, maxTimeMs: 120_000 },
  },
  reviewer: {
    systemPrompt: 'You are a code review agent. Check for bugs, security issues, and style violations. Be specific and concise.',
    budget: { maxTurns: 5, maxTimeMs: 60_000 },
  },
  critic: {
    systemPrompt: 'You are a critic agent. Evaluate the proposed approach. Identify flaws, missing edge cases, and risks.',
    budget: { maxTurns: 5, maxTimeMs: 60_000 },
  },
  summariser: {
    systemPrompt: 'You are a summarisation agent. Condense the input into a clear, structured summary.',
    budget: { maxTurns: 3, maxTimeMs: 30_000 },
  },
  tool_executor: {
    systemPrompt: 'You are a tool execution agent. Use the available tools to complete the task. Report results concisely.',
    budget: { maxTurns: 10, maxTimeMs: 120_000 },
  },
  service_operator: {
    systemPrompt: 'You are a service operator agent. Manage the service state, execute commands, and report status.',
    budget: { maxTurns: 8, maxTimeMs: 90_000 },
  },
  safety_checker: {
    systemPrompt: 'You are a safety checker. Evaluate actions for security risks, data leaks, and unintended side effects. Block unsafe operations.',
    budget: { maxTurns: 3, maxTimeMs: 30_000 },
  },
  context_compressor: {
    systemPrompt: 'You are a context compression agent. Reduce the input to its essential information without losing important details.',
    budget: { maxTurns: 3, maxTimeMs: 30_000 },
  },
};

export function getAgentRoleDefaults(role: AgentRole): { systemPrompt: string; budget: AgentBudget } {
  return ROLE_DEFAULTS[role];
}

// ─── Parallel orchestrator ──────────────────────────────────────────

/**
 * Execute multiple subagent tasks with dependency ordering and parallelism.
 * Tasks with no dependencies run in parallel. Tasks with dependencies wait
 * for their prerequisites to complete.
 */
export async function orchestrate(
  tasks: WorkstreamTask[],
  parentClient: IChatClient,
  availableTools: Tool[],
  projectDir?: string,
  verify?: BranchVerifier,
): Promise<OrchestrationResult> {
  const started = Date.now();
  const results = new Map<string, WorkstreamResult>();
  const pending = new Set(tasks.map((t) => t.id));

  // Topological execution with parallelism
  while (pending.size > 0) {
    const ready = tasks.filter((t) => {
      if (!pending.has(t.id)) return false;
      const deps = t.dependsOn ?? [];
      return deps.every((d) => results.has(d));
    });

    if (ready.length === 0 && pending.size > 0) {
      // Circular dependency or missing task
      for (const id of pending) {
        results.set(id, { id, role: 'planner', output: '', success: false, duration_ms: 0, error: 'Circular or missing dependency' });
      }
      break;
    }

    // Execute ready tasks in parallel
    const batch = await Promise.allSettled(
      ready.map((task) => executeTask(task, parentClient, availableTools, results, projectDir, verify)),
    );

    for (let i = 0; i < ready.length; i++) {
      const task = ready[i];
      const result = batch[i];
      if (result.status === 'fulfilled') {
        results.set(task.id, result.value);
      } else {
        results.set(task.id, {
          id: task.id,
          role: task.role,
          output: '',
          success: false,
          duration_ms: 0,
          error: result.reason?.message ?? 'Unknown error',
        });
      }
      pending.delete(task.id);
    }
  }

  const allResults = tasks.map((t) => results.get(t.id)!);
  // Populate merged_output: when a verifier is supplied, merge only proven
  // branches (mergeVerified); otherwise fall back to the completion-based merge.
  const merged_output = verify ? mergeVerified(allResults) : mergeResults(allResults);
  return {
    results: allResults,
    merged_output,
    total_duration_ms: Date.now() - started,
    tasks_succeeded: allResults.filter((r) => r.success).length,
    tasks_failed: allResults.filter((r) => !r.success).length,
  };
}

async function executeTask(
  task: WorkstreamTask,
  parentClient: IChatClient,
  availableTools: Tool[],
  priorResults: Map<string, WorkstreamResult>,
  projectDir?: string,
  verify?: BranchVerifier,
): Promise<WorkstreamResult> {
  const roleDefaults = ROLE_DEFAULTS[task.role];
  const budget: AgentBudget = { ...roleDefaults.budget, ...task.budget };

  // Inject dependency outputs into the prompt
  let enrichedPrompt = task.prompt;
  const deps = task.dependsOn ?? [];
  if (deps.length > 0) {
    const context = deps
      .map((d) => priorResults.get(d))
      .filter(Boolean)
      .map((r) => `[${r!.role} result]: ${r!.output}`)
      .join('\n\n');
    enrichedPrompt = `${context}\n\n---\n\n${task.prompt}`;
  }

  const config: SubagentConfig = {
    name: `${task.role}_${task.id}`,
    systemPrompt: roleDefaults.systemPrompt,
    maxTurns: budget.maxTurns,
    metricsProjectDir: projectDir,
  };

  const started = Date.now();
  try {
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`Agent budget exceeded: ${budget.maxTimeMs}ms`)), budget.maxTimeMs),
    );

    const output = await Promise.race([
      runSubagent(config, enrichedPrompt, parentClient, availableTools),
      timeoutPromise,
    ]);

    const base: WorkstreamResult = {
      id: task.id,
      role: task.role,
      output,
      success: output.length > 0,
      duration_ms: Date.now() - started,
    };
    return attachVerification(base, verify, projectDir);
  } catch (err: unknown) {
    return {
      id: task.id,
      role: task.role,
      output: '',
      success: false,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Merge outputs from multiple workstream results into a single summary. */
export function mergeResults(results: WorkstreamResult[]): string {
  const successful = results.filter((r) => r.success);
  if (successful.length === 0) return '(all workstreams failed)';

  return successful
    .map((r) => `## ${r.role} (${r.id})\n\n${r.output}`)
    .join('\n\n---\n\n');
}

/**
 * Verified merge: include a branch's output ONLY if it completed AND its work
 * verified `pass`. Unlike mergeResults (which merges on `success`, i.e. mere
 * completion), this gates on the verification verdict via planVerifiedMerge —
 * speculative parallel work is not merged without proof. Rejected branches are
 * listed with their reason so the exclusion is visible rather than silent.
 */
export function mergeVerified(results: WorkstreamResult[]): string {
  const branches: BranchVerification[] = results.map((r) => ({
    id: r.id,
    completed: r.success,
    verification: r.verification,
  }));
  const plan = planVerifiedMerge(branches);

  const byId = new Map(results.map((r) => [r.id, r]));
  const merged = plan.mergeable
    .map((d) => byId.get(d.id)!)
    .map((r) => `## ${r.role} (${r.id})\n\n${r.output}`)
    .join('\n\n---\n\n');

  if (plan.rejected.length === 0) {
    return merged || '(no verified workstreams to merge)';
  }

  const rejectedNote = plan.rejected
    .map((d) => `- ${d.id}: ${d.reason}`)
    .join('\n');
  const header = merged || '(no verified workstreams to merge)';
  return `${header}\n\n---\n\n### Excluded (unverified)\n${rejectedNote}`;
}
