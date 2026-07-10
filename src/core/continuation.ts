// Phase 4: cross-loop continuation.
//
// Answers the question "if a build needs another loop to finish, does it just
// stop?" Today ralphLoop (cookbook/task-loop.ts) halts at several non-error
// exits — time budget exhausted, a prerequisite permanently failed, or the
// plan finished with failures — and leaves the remaining work stranded.
//
// This module is the bounded decision layer in front of those halts. It is
// pure where it can be (classification + decomposition) and does thin,
// well-defined I/O for the meta-budget marker and the continuation request it
// hands to whatever orchestrator (or human) starts the next bounded loop.
//
// Two safety properties are load-bearing:
//   1. Hard errors and user-requested shutdowns NEVER auto-continue.
//   2. A meta-budget caps how many follow-on loops can ever be spawned, so a
//      task that keeps failing cannot drive an unbounded chain of retries.

import * as fs from 'fs';
import * as path from 'path';

export type LoopEndReason =
  | 'all-tasks-complete'
  | 'blocked-by-failed-prerequisite'
  | 'finished-with-failures'
  | 'time-budget-exhausted'
  | 'iteration-budget-exhausted'
  | 'graceful-shutdown'
  | 'error'
  | 'aborted';

export type ContinuationTaskStatus = 'pending' | 'done' | 'failed';
export type ContinuationTaskKind = 'code' | 'research' | 'external';

/** Mirrors the cookbook task shape, kept local so core does not depend on cookbook. */
export interface ContinuationTask {
  id: string;
  title: string;
  status: ContinuationTaskStatus;
  anchors: string[];
  target?: string;
  kind?: ContinuationTaskKind;
}

export interface ContinuationInput {
  endReason: LoopEndReason;
  tasks: ContinuationTask[];
  /** Follow-on loops already spawned in this lineage. */
  continuationsUsed: number;
  /** Hard cap on follow-on loops. <= 0 disables continuation entirely. */
  maxContinuations: number;
}

export type ContinuationAction = 'continue' | 'stop';

export interface ContinuationDecision {
  action: ContinuationAction;
  reason: string;
  /** All tasks not yet done (the work that remains). */
  remainingTasks: ContinuationTask[];
  /**
   * When action === 'continue', the task list a fresh bounded loop should run:
   * remaining tasks with any permanently-failed task reset to pending so it
   * gets a fresh per-task retry budget. Empty when action === 'stop'.
   */
  followOnTasks: ContinuationTask[];
}

/** Halts that represent a deliberate, final stop — never auto-continued. */
const NON_CONTINUABLE: ReadonlySet<LoopEndReason> = new Set<LoopEndReason>([
  'all-tasks-complete',
  'graceful-shutdown',
  'error',
  'aborted',
]);

/**
 * Decide whether the stranded work warrants another bounded loop. Pure; no I/O.
 */
export function classifyContinuation(input: ContinuationInput): ContinuationDecision {
  const remainingTasks = input.tasks.filter((t) => t.status !== 'done');

  if (NON_CONTINUABLE.has(input.endReason)) {
    return { action: 'stop', reason: `End reason '${input.endReason}' is a final stop.`, remainingTasks, followOnTasks: [] };
  }
  if (remainingTasks.length === 0) {
    return { action: 'stop', reason: 'No remaining tasks.', remainingTasks, followOnTasks: [] };
  }
  if (input.maxContinuations <= 0) {
    return { action: 'stop', reason: 'Continuation disabled (maxContinuations <= 0).', remainingTasks, followOnTasks: [] };
  }
  if (input.continuationsUsed >= input.maxContinuations) {
    return {
      action: 'stop',
      reason: `Meta-budget exhausted (${input.continuationsUsed}/${input.maxContinuations} continuations used).`,
      remainingTasks,
      followOnTasks: [],
    };
  }

  const followOnTasks = remainingTasks.map((t) =>
    t.status === 'failed' ? { ...t, status: 'pending' as const } : { ...t },
  );
  return {
    action: 'continue',
    reason: `${remainingTasks.length} task(s) remain after '${input.endReason}'; ${input.continuationsUsed + 1}/${input.maxContinuations} continuation.`,
    remainingTasks,
    followOnTasks,
  };
}

/**
 * Split one (typically permanently-failed or oversized) task into sub-tasks.
 * Pure. Sub-tasks inherit the parent's anchors/target/kind and get stable,
 * collision-free ids derived from the parent id. Each starts pending.
 */
export function decomposeFailedTask(task: ContinuationTask, subTitles: string[]): ContinuationTask[] {
  return subTitles
    .map((title) => title.trim())
    .filter((title) => title.length > 0)
    .map((title, index) => ({
      id: `${task.id}-${index + 1}`,
      title,
      status: 'pending' as const,
      anchors: [...task.anchors],
      ...(task.target ? { target: task.target } : {}),
      ...(task.kind ? { kind: task.kind } : {}),
    }));
}

/**
 * Replace a task in the plan with its decomposed sub-tasks. Pure. Returns a new
 * list; if the id is absent or no valid sub-titles are given, returns the input
 * unchanged (the caller can detect the no-op by reference/length).
 */
export function applyDecomposition(
  tasks: ContinuationTask[],
  taskId: string,
  subTitles: string[],
): ContinuationTask[] {
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index === -1) return tasks;
  const subTasks = decomposeFailedTask(tasks[index], subTitles);
  if (subTasks.length === 0) return tasks;
  return [...tasks.slice(0, index), ...subTasks, ...tasks.slice(index + 1)];
}

/**
 * Serialize tasks to IMPLEMENTATION_PLAN.md lines. Matches the grammar that
 * cookbook/task-loop.ts writePlan emits and parsePlan reads, so a follow-on
 * loop consumes them without a translation step.
 */
export function serializePlanTasks(tasks: ContinuationTask[]): string {
  const lines = ['# Implementation Plan', ''];
  for (const task of tasks) {
    const marker = task.status === 'done' ? 'x' : task.status === 'failed' ? '!' : ' ';
    lines.push(`- [${marker}] ${task.id} — ${task.title}`);
    for (const anchor of task.anchors) lines.push(`  - anchor: ${anchor}`);
    if (task.target) lines.push(`  - target: ${task.target}`);
    if (task.kind && task.kind !== 'code') lines.push(`  - kind: ${task.kind}`);
  }
  return lines.join('\n') + '\n';
}

// ── Meta-budget + continuation request markers ──────────────────────────────

const CONTINUATION_DIR = path.join('.harness', 'continuation');
const STATE_RELPATH = path.join(CONTINUATION_DIR, 'state.json');
const REQUEST_RELPATH = path.join(CONTINUATION_DIR, 'request.json');

export interface ContinuationState {
  continuationsUsed: number;
  maxContinuations: number;
  updatedAt: string;
}

export interface ContinuationRequest {
  createdAt: string;
  endReason: LoopEndReason;
  reason: string;
  continuationsUsed: number;
  maxContinuations: number;
  remainingTaskIds: string[];
  /** The plan a fresh bounded loop should run (already failed->pending reset). */
  followOnTasks: ContinuationTask[];
}

/** Read the lineage meta-budget state, or a zeroed default. */
export function readContinuationState(projectDir: string, maxContinuations: number): ContinuationState {
  const statePath = path.join(projectDir, STATE_RELPATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<ContinuationState>;
    const used = typeof parsed.continuationsUsed === 'number' && parsed.continuationsUsed >= 0 ? parsed.continuationsUsed : 0;
    return { continuationsUsed: used, maxContinuations, updatedAt: parsed.updatedAt ?? '' };
  } catch {
    return { continuationsUsed: 0, maxContinuations, updatedAt: '' };
  }
}

/** Increment and persist the lineage continuation counter. Returns the new state. */
export function recordContinuation(projectDir: string, maxContinuations: number, now: Date = new Date()): ContinuationState {
  const prev = readContinuationState(projectDir, maxContinuations);
  const next: ContinuationState = {
    continuationsUsed: prev.continuationsUsed + 1,
    maxContinuations,
    updatedAt: now.toISOString(),
  };
  const statePath = path.join(projectDir, STATE_RELPATH);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Reset the lineage counter (e.g. when a plan completes cleanly). */
export function clearContinuationState(projectDir: string): void {
  const statePath = path.join(projectDir, STATE_RELPATH);
  try {
    fs.rmSync(statePath, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Write the continuation request marker a follow-on runner / human consumes. */
export function writeContinuationRequest(projectDir: string, request: ContinuationRequest): void {
  const requestPath = path.join(projectDir, REQUEST_RELPATH);
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), 'utf8');
}

/** Read the pending continuation request, or null if none/unreadable. */
export function readContinuationRequest(projectDir: string): ContinuationRequest | null {
  const requestPath = path.join(projectDir, REQUEST_RELPATH);
  try {
    return JSON.parse(fs.readFileSync(requestPath, 'utf8')) as ContinuationRequest;
  } catch {
    return null;
  }
}
