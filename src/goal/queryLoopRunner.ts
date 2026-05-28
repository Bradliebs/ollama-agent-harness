// Goal iteration runner: drive the harness queryLoop for one iteration.
//
// Companion to shellRunner. Where shellRunner spawns a command per
// iteration, queryLoopRunner runs the chat agent itself — same model,
// same tools, same loop machinery — scoped to the goal's TaskContract.
//
// Each iteration injects a single user message ("iteration N of <target>")
// and lets the loop run to its own completion (max_turns, validation
// failure, etc.). The outer goal loop in src/goal/loop.ts handles
// verification and the convergence decision between iterations.

import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import type { IChatClient } from '../core/chatClient';
import type { LoopConfig, Tool, ToolCall } from '../types';
import type { TaskContract, TaskContractMode } from '../types/taskContract';
import { filterTools, goalToTaskContractFragment } from './loopConfig';
import type { Goal } from './types';
import type { IterationOutcome } from './loop';
import type { IterationRunner } from './shellRunner';

export interface MakeQueryLoopRunnerOptions {
  client: IChatClient;
  tools: Tool[];
  model: string;
  systemPrompt: string;
  /** Default per-iteration max turns inside the queryLoop. Falls back to
   * goal's budget.maxIterations if set; otherwise 12. */
  maxTurnsPerIteration?: number;
  /** TaskContract mode tag. Default 'general'. */
  mode?: TaskContractMode;
  /** Per-iteration time budget in ms. Forwarded to LoopConfig.maxTimeMs. */
  maxTimeMs?: number;
  /** Truncate captured notes (assistant final text) at this many chars. */
  maxNotesChars?: number;
  /** Forwarded to QueryLoopDeps (hooks, tracer, session, etc.). */
  extraDeps?: Omit<QueryLoopDeps, 'client' | 'tools'>;
}

export function makeQueryLoopRunner(opts: MakeQueryLoopRunnerOptions): IterationRunner {
  const notesCap = opts.maxNotesChars ?? 4_000;
  const mode: TaskContractMode = opts.mode ?? 'general';

  return async (goal: Goal, n: number): Promise<IterationOutcome> => {
    const tools = filterTools(opts.tools, goal);
    const fragment = goalToTaskContractFragment(goal);
    const maxTurns = opts.maxTurnsPerIteration ?? fragment.max_turns ?? 12;

    const taskContract: TaskContract = {
      task_id: `${goal.id}-iter-${n}`,
      goal: fragment.goal,
      mode,
      intent_type: 'goal_iteration',
      constraints: fragment.constraints,
      allowed_paths: [],
      blocked_paths: fragment.blocked_paths,
      validation: fragment.validation,
      success_criteria: fragment.success_criteria,
      failure_triggers: [],
      approval_required: false,
      max_turns: maxTurns,
      high_risk: false,
      created_at: new Date().toISOString(),
      source: 'derived',
    };

    const config: LoopConfig = {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      maxTurns,
      taskContract,
      maxTimeMs: opts.maxTimeMs,
    };

    const initialMessage = buildIterationPrompt(goal, n);
    const deps: QueryLoopDeps = { client: opts.client, tools, ...(opts.extraDeps ?? {}) };

    let toolCalls = 0;
    const filesTouched = new Set<string>();
    let tokensUsed = 0;
    let lastText = '';
    let doneReason: string | undefined;
    let firstError: string | undefined;

    try {
      for await (const ev of queryLoop(config, deps, [{ role: 'user', content: initialMessage }])) {
        switch (ev.type) {
          case 'tool_call':
            toolCalls += 1;
            collectFilePath(ev.call, filesTouched);
            break;
          case 'usage':
            tokensUsed += (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0);
            break;
          case 'text':
            lastText = ev.content;
            break;
          case 'error':
            if (!firstError) firstError = ev.message;
            break;
          case 'done':
            doneReason = ev.reason;
            break;
        }
      }
    } catch (err) {
      return {
        action: `iter ${n}: queryLoop threw`,
        error: err instanceof Error ? err.message : String(err),
        notes: truncate(lastText, notesCap),
        toolCalls,
        filesTouched: [...filesTouched],
        tokensUsed,
      };
    }

    return {
      action: `iter ${n}: queryLoop done (${doneReason ?? 'no-done-event'})`,
      toolCalls,
      filesTouched: [...filesTouched],
      tokensUsed,
      notes: truncate(lastText, notesCap),
      error: firstError,
    };
  };
}

function buildIterationPrompt(goal: Goal, n: number): string {
  const lastIter = goal.iterations.length > 0 ? goal.iterations[goal.iterations.length - 1] : null;
  const lines: string[] = [];
  lines.push(`This is iteration ${n} of an autonomy goal.`);
  lines.push('');
  lines.push(`**Goal:** ${goal.target}`);
  if (lastIter) {
    lines.push('');
    lines.push(`**Previous iteration (#${lastIter.n}):** ${lastIter.action}`);
    if (lastIter.notes) lines.push(`- notes: ${lastIter.notes.slice(0, 500)}`);
  }
  lines.push('');
  lines.push('Make concrete progress this iteration. The outer loop will run verification after you finish.');
  return lines.join('\n');
}

function collectFilePath(call: ToolCall, out: Set<string>): void {
  // ToolCall.args is the canonical field across tools; some adapters may
  // expose it under .arguments. Probe both before giving up.
  const args = (call as { args?: unknown }).args ?? (call as { arguments?: unknown }).arguments;
  if (!args || typeof args !== 'object') return;
  const path = (args as Record<string, unknown>).path;
  if (typeof path === 'string' && path.length > 0) out.add(path);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated ${s.length - max} chars)`;
}
