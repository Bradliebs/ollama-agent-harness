// Pure translation helpers between an Active Goal and the existing LoopConfig
// / TaskContract surface. Keeping this isolated so the goal module never
// imports the chat client, dispatcher, or web server.

import type { Goal, GoalConstraint } from './types';

export interface GoalBudgetView {
  /** Hard cap on outer-loop iterations. */
  maxIterations?: number;
  /** Wall-clock budget across the whole goal in ms. */
  maxDurationMs?: number;
  /** Token cap to enforce via cost tracking. */
  maxTokens?: number;
  /** USD cap to enforce via cost tracking. */
  maxUsd?: number;
}

/** Pull every budget / time / cost constraint into a single view. */
export function extractBudget(goal: Goal): GoalBudgetView {
  const out: GoalBudgetView = {};
  for (const c of goal.constraints) {
    switch (c.spec.kind) {
      case 'budget':
        out.maxIterations = c.spec.maxIterations;
        break;
      case 'time':
        out.maxDurationMs = c.spec.maxDurationMs;
        break;
      case 'cost':
        if (c.spec.maxTokens !== undefined) out.maxTokens = c.spec.maxTokens;
        if (c.spec.maxUsd !== undefined) out.maxUsd = c.spec.maxUsd;
        break;
    }
  }
  return out;
}

/** All path globs the goal forbids touching, deduplicated. */
export function extractForbiddenPaths(goal: Goal): string[] {
  const set = new Set<string>();
  for (const c of goal.constraints) {
    if (c.spec.kind === 'path_forbid') {
      for (const g of c.spec.globs) set.add(g);
    }
  }
  return [...set];
}

/** All tool names the goal forbids, as a Set for cheap lookup. */
export function extractForbiddenTools(goal: Goal): Set<string> {
  const set = new Set<string>();
  for (const c of goal.constraints) {
    if (c.spec.kind === 'tool_forbid') {
      for (const t of c.spec.tools) set.add(t);
    }
  }
  return set;
}

/** Filter a tool list by goal `tool_forbid` constraints. Stable order. */
export function filterTools<T extends { name: string }>(tools: T[], goal: Goal): T[] {
  const forbidden = extractForbiddenTools(goal);
  if (forbidden.size === 0) return tools;
  return tools.filter((t) => !forbidden.has(t.name));
}

/** Human-readable, deduplicated list of constraint descriptions for prompt injection. */
export function describeConstraints(goal: Goal): string[] {
  const lines: string[] = [];
  for (const c of goal.constraints) {
    lines.push(constraintToLine(c));
  }
  return lines;
}

function constraintToLine(c: GoalConstraint): string {
  switch (c.spec.kind) {
    case 'path_forbid':
      return `Do not modify: ${c.spec.globs.join(', ')}`;
    case 'tool_forbid':
      return `Do not call tools: ${c.spec.tools.join(', ')}`;
    case 'budget':
      return `Iteration budget: ${c.spec.maxIterations}`;
    case 'time':
      return `Time budget: ${Math.round(c.spec.maxDurationMs / 1000)}s`;
    case 'cost': {
      const parts: string[] = [];
      if (c.spec.maxTokens !== undefined) parts.push(`${c.spec.maxTokens} tokens`);
      if (c.spec.maxUsd !== undefined) parts.push(`$${c.spec.maxUsd.toFixed(2)}`);
      return `Cost cap: ${parts.join(' / ')}`;
    }
    case 'custom':
      return c.spec.description;
  }
}

/**
 * A subset of `TaskContract`-shaped fields derived from the goal, suitable
 * for merging into a caller-built `TaskContract`. We don't construct the
 * full contract here because TaskContract carries IDs, modes, and metadata
 * that are session-level concerns owned by the caller.
 */
export interface GoalTaskContractFragment {
  goal: string;
  constraints: string[];
  blocked_paths: string[];
  validation: string[];
  success_criteria: string[];
  max_turns?: number;
}

export function goalToTaskContractFragment(goal: Goal): GoalTaskContractFragment {
  const budget = extractBudget(goal);
  const fragment: GoalTaskContractFragment = {
    goal: goal.target,
    constraints: describeConstraints(goal),
    blocked_paths: extractForbiddenPaths(goal),
    validation: goal.verification.map((c) => c.description),
    // Required checks describe what "done" looks like.
    success_criteria: goal.verification.filter((c) => c.required).map((c) => c.description),
  };
  if (budget.maxIterations !== undefined) fragment.max_turns = budget.maxIterations;
  return fragment;
}
