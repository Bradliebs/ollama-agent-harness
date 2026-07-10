// Active Goal — schema for the goal-driven autonomy loop.
//
// A Goal is a persistent target with verification and constraints. It lives
// across turns, sessions, and process restarts until it reaches a terminal
// state (complete | failed | abandoned).
//
// Phase 1 ships types + store + verification runners. The loop, constraint
// enforcement at the dispatcher, and UI wiring land in later phases.

export const GOAL_SCHEMA_VERSION = 1;

export type GoalStatus =
  | 'draft'        // articulated, not yet running
  | 'active'       // loop is iterating
  | 'paused'       // human stopped it
  | 'blocked'      // loop hit an unrecoverable condition, awaiting human
  | 'complete'     // all required verifications pass
  | 'failed'       // a constraint was exceeded
  | 'abandoned';   // user gave up

// ─── Verification ────────────────────────────────────────────────────

export type GoalCheckKind =
  | 'command'
  | 'file_exists'
  | 'http'
  | 'model_judge'
  | 'test_suite';

export type GoalCheckSpec =
  | { kind: 'command'; command: string; args?: string[]; cwd?: string; expectExitCode?: number; expectStdoutMatches?: string; timeoutMs?: number }
  | { kind: 'file_exists'; path: string; mustContain?: string }
  | { kind: 'http'; url: string; expectStatus?: number; expectBodyMatches?: string; timeoutMs?: number }
  | { kind: 'model_judge'; rubric: string; minScore?: number }
  | { kind: 'test_suite'; command: string; args?: string[]; cwd?: string; minPassRate?: number; timeoutMs?: number };

export interface GoalCheckResult {
  passed: boolean;
  timestamp: string;
  evidence: string;     // command output, response body, judge rationale, etc.
  durationMs: number;
  // For test_suite: parsed counts when the runner output could be parsed.
  testCounts?: { passed: number; failed: number; total: number };
  // For model_judge: numeric score the judge returned.
  judgeScore?: number;
}

export interface GoalCheck {
  id: string;
  description: string;
  required: boolean;
  spec: GoalCheckSpec;
  lastResult?: GoalCheckResult;
}

// ─── Constraints ─────────────────────────────────────────────────────

export type GoalConstraintKind =
  | 'path_forbid'
  | 'tool_forbid'
  | 'budget'
  | 'time'
  | 'cost'
  | 'custom';

export type GoalConstraintSpec =
  | { kind: 'path_forbid'; globs: string[] }
  | { kind: 'tool_forbid'; tools: string[] }
  | { kind: 'budget'; maxIterations: number }
  | { kind: 'time'; maxDurationMs: number }
  | { kind: 'cost'; maxTokens?: number; maxUsd?: number }
  | { kind: 'custom'; description: string };

export interface GoalConstraint {
  id: string;
  description: string;
  spec: GoalConstraintSpec;
}

// ─── Iteration record ────────────────────────────────────────────────

export interface GoalIteration {
  n: number;
  startedAt: string;
  endedAt: string;
  action: string;
  toolCalls: number;
  verificationsRun: number;
  verificationsPassed: number;
  filesTouched: string[];
  tokensUsed?: number;
  notes: string;
  stuckSignal?: 'no_progress' | 'repeated_failure' | 'constraint_hit';
}

// ─── Evidence trail ──────────────────────────────────────────────────

export interface GoalEvidence {
  commits: string[];        // git SHAs touched while goal active
  files: string[];          // files modified (deduplicated)
  checkHistory: Array<{ checkId: string; result: GoalCheckResult }>;
}

// ─── Goal ────────────────────────────────────────────────────────────

export interface GoalPause {
  reason: string;
  pausedAt: string;
  pausedBy: 'human' | 'agent' | 'system';
}

export interface GoalBlock {
  reason: string;
  blockedAt: string;
  needs: string;            // what's required to unblock
}

// Honest snapshot, taken at completion time, of whether the verification that
// grounded this completion was adequate proof for the task kind. Captured here
// rather than recomputed because a goal's verification array can change after
// the fact — the audit record must reflect what actually grounded completion.
export interface GoalCompletionVerdict {
  verified: boolean;          // completion rested on adequate proof for the task kind
  executionGrounded: boolean; // task kind requires deterministic proof (code/edit/data)
  reason: string;             // human-readable explanation from the adequacy assessment
  at: string;
}

export interface Goal {
  schemaVersion: typeof GOAL_SCHEMA_VERSION;
  id: string;
  target: string;
  status: GoalStatus;
  verification: GoalCheck[];
  constraints: GoalConstraint[];
  iterations: GoalIteration[];
  evidence: GoalEvidence;
  spawnedFrom?: string;
  pause?: GoalPause;
  block?: GoalBlock;
  completionVerdict?: GoalCompletionVerdict;  // set on transition into 'complete'
  startedAt?: string;       // first transition into 'active'
  createdAt: string;
  updatedAt: string;
}

// ─── Factory helpers ─────────────────────────────────────────────────

export interface NewGoalInput {
  target: string;
  verification?: GoalCheck[];
  constraints?: GoalConstraint[];
  spawnedFrom?: string;
}

export function makeGoal(input: NewGoalInput, id: string, now: Date = new Date()): Goal {
  const iso = now.toISOString();
  return {
    schemaVersion: GOAL_SCHEMA_VERSION,
    id,
    target: input.target,
    status: 'draft',
    verification: input.verification ?? [],
    constraints: input.constraints ?? [],
    iterations: [],
    evidence: { commits: [], files: [], checkHistory: [] },
    spawnedFrom: input.spawnedFrom,
    createdAt: iso,
    updatedAt: iso,
  };
}

// Status transitions allowed by the loop. Anything else is a programming
// error and store.update should reject it.
const ALLOWED_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  draft:     ['active', 'abandoned'],
  active:    ['paused', 'blocked', 'complete', 'failed', 'abandoned'],
  paused:    ['active', 'abandoned'],
  blocked:   ['active', 'abandoned', 'failed'],
  complete:  [],
  failed:    [],
  abandoned: [],
};

export function isTransitionAllowed(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: GoalStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'abandoned';
}
