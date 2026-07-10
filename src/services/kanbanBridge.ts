/**
 * Kanban bridge — maps taskStore tasks to a 3-column Kanban view
 * (triage / doing / done) and promotes any task that lands in the
 * triage column into the autonomy loop's IMPLEMENTATION_PLAN.md so
 * the next loop iteration picks it up.
 *
 * Mapping convention:
 *   Column "triage" → tag "kanban:triage" OR status "pending"
 *   Column "doing"  → tag "kanban:doing"  OR status in {assigned, in_progress, review}
 *   Column "done"   → tag "kanban:done"   OR status in {done, cancelled, failed}
 *
 * An explicit "kanban:*" tag always wins over the status-based default.
 * That lets the UI move a card without touching its lifecycle state.
 *
 * Promotion contract (triage → plan):
 *   - Idempotent: a task whose id already appears in the plan is not
 *     duplicated.
 *   - The resulting plan task uses the same id as the source task
 *     (slugified for safety), the task title verbatim, and a `kind:`
 *     inferred from task tags ("kind:code"/"kind:research"/"kind:external"
 *     wins; otherwise default code).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Task, TaskStatus } from './taskStore';
import { renderTasksAsPlanMarkdown, type PlanTask, type TaskKind } from './goalExpander';

export type KanbanColumn = 'triage' | 'doing' | 'done';

export const KANBAN_TAGS: Record<KanbanColumn, string> = {
  triage: 'kanban:triage',
  doing: 'kanban:doing',
  done: 'kanban:done',
};

const DOING_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['assigned', 'in_progress', 'review', 'blocked']);
const DONE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'cancelled', 'failed']);

/**
 * Decide which Kanban column a task belongs to. Explicit `kanban:*`
 * tags always win — that's how the UI moves a card without touching
 * the task's lifecycle state.
 */
export function taskToColumn(task: Task): KanbanColumn {
  const tags = task.tags ?? [];
  if (tags.includes(KANBAN_TAGS.done)) return 'done';
  if (tags.includes(KANBAN_TAGS.doing)) return 'doing';
  if (tags.includes(KANBAN_TAGS.triage)) return 'triage';
  if (DONE_STATUSES.has(task.status)) return 'done';
  if (DOING_STATUSES.has(task.status)) return 'doing';
  return 'triage';
}

/**
 * Group an arbitrary list of tasks into the 3-column board view.
 * Order within each column preserves caller order.
 */
export function groupTasksByColumn(tasks: Task[]): Record<KanbanColumn, Task[]> {
  const board: Record<KanbanColumn, Task[]> = { triage: [], doing: [], done: [] };
  for (const t of tasks) board[taskToColumn(t)].push(t);
  return board;
}

/**
 * Replace the kanban:* tag on a task. Returns the new tag set with at
 * most one kanban tag. Other tags (including `kind:*`) are preserved.
 */
export function withKanbanTag(currentTags: string[] | undefined, column: KanbanColumn): string[] {
  const filtered = (currentTags ?? []).filter((t) => !t.startsWith('kanban:'));
  filtered.push(KANBAN_TAGS[column]);
  return filtered;
}

/**
 * Extract a TaskKind from tag list (`kind:code`, `kind:research`,
 * `kind:external`). Returns undefined when no recognised tag is set.
 */
export function inferKindFromTags(tags: string[] | undefined): TaskKind | undefined {
  for (const tag of tags ?? []) {
    if (tag === 'kind:code') return 'code';
    if (tag === 'kind:research') return 'research';
    if (tag === 'kind:external') return 'external';
  }
  return undefined;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
}

/**
 * Map a taskStore Task into a plan-shaped task. Uses the task id when
 * it's already slug-shaped; otherwise slugifies the title.
 */
export function taskToPlanTask(task: Task): PlanTask {
  const id = /^[a-z0-9-]+$/.test(task.id) ? task.id : slugify(task.title || task.id);
  const kind = inferKindFromTags(task.tags);
  const anchors = (task.tags ?? [])
    .filter((t) => t.startsWith('anchor:'))
    .map((t) => t.slice('anchor:'.length))
    .filter(Boolean);
  return { id, title: task.title, kind, anchors: anchors.length ? anchors : undefined };
}

export interface PlanIoHooks {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  appendFile: (p: string, data: string) => Promise<void>;
  access: (p: string) => Promise<void>;
}

const defaultIo: PlanIoHooks = {
  readFile: (p) => fs.readFile(p, 'utf-8'),
  writeFile: (p, data) => fs.writeFile(p, data, 'utf-8'),
  appendFile: (p, data) => fs.appendFile(p, data, 'utf-8'),
  access: (p) => fs.access(p),
};

/**
 * Read the plan file and return the set of task ids it already declares.
 * Returns an empty set if the file does not exist.
 */
async function readPlanIds(planPath: string, io: PlanIoHooks): Promise<Set<string>> {
  try {
    await io.access(planPath);
  } catch {
    return new Set();
  }
  let text: string;
  try {
    text = await io.readFile(planPath);
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^- \[.\] (\S+)\s+[—-]/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

export interface PromoteResult {
  /** Tasks actually appended (skips ids already present). */
  appended: PlanTask[];
  /** Tasks skipped because their id was already in the plan. */
  skipped: PlanTask[];
  /** True if the plan file was modified. */
  mutated: boolean;
}

/**
 * Append any "triage"-column tasks that aren't already in the plan.
 * Idempotent — running twice is a no-op for the second call.
 */
export async function promoteTriageToPlan(
  tasks: Task[],
  options: { projectDir: string; planPath?: string; io?: PlanIoHooks },
): Promise<PromoteResult> {
  const io = options.io ?? defaultIo;
  const planPath = path.resolve(options.projectDir, options.planPath ?? 'IMPLEMENTATION_PLAN.md');

  const triage = tasks.filter((t) => taskToColumn(t) === 'triage');
  if (triage.length === 0) return { appended: [], skipped: [], mutated: false };

  const existingIds = await readPlanIds(planPath, io);
  const appended: PlanTask[] = [];
  const skipped: PlanTask[] = [];

  for (const t of triage) {
    const planTask = taskToPlanTask(t);
    if (existingIds.has(planTask.id)) {
      skipped.push(planTask);
      continue;
    }
    appended.push(planTask);
    existingIds.add(planTask.id);
  }

  if (appended.length === 0) return { appended, skipped, mutated: false };

  const block = renderTasksAsPlanMarkdown(appended);
  let exists = true;
  try {
    await io.access(planPath);
  } catch {
    exists = false;
  }
  if (exists) {
    const current = await io.readFile(planPath);
    const sep = current.endsWith('\n') ? '' : '\n';
    await io.appendFile(planPath, sep + block);
  } else {
    await io.writeFile(planPath, '# Implementation Plan\n\n' + block);
  }
  return { appended, skipped, mutated: true };
}
