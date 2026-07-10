import { promises as fs } from 'node:fs';
import path from 'node:path';
import express from 'express';

// Project Atlas — a structural/historical map of a vibe-coded project.
//
// The live dashboard answers "what is happening now". The Atlas answers the
// orthogonal question "what EXISTS and how did it get here": which files the
// autonomy loop has built, which task built them, when they last changed, and
// the current plan status of each task.
//
// It is pure synthesis over two append-only sources the loop already writes —
// IMPLEMENTATION_PLAN.md (the task queue) and .forge-history.jsonl (the per-task
// change log with exact changedFiles). It never mutates anything.

export type TaskStatus = 'pending' | 'done' | 'failed';

export interface AtlasPlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  anchors: string[];
  target?: string;
}

export interface AtlasHistoryEntry {
  timestamp?: string;
  iteration?: number;
  taskId?: string;
  taskTitle?: string;
  status?: 'done' | 'failed';
  elapsedMs?: number;
  filesChanged?: number;
  changedFiles?: string[];
  model?: string;
}

export interface AtlasFileNode {
  path: string;
  changeCount: number;
  lastChangedAt?: string;
  lastChangedByTaskId?: string;
  lastChangedByTaskTitle?: string;
  contributingTaskIds: string[];
  planStatus?: TaskStatus;
}

export interface AtlasTaskNode {
  id: string;
  title: string;
  planStatus?: TaskStatus;
  target?: string;
  anchors: string[];
  runCount: number;
  lastRunAt?: string;
  lastRunStatus?: 'done' | 'failed';
  changedFiles: string[];
  inPlan: boolean;
  inHistory: boolean;
}

export interface AtlasMap {
  generatedAt: string;
  summary: {
    filesTracked: number;
    tasksTotal: number;
    tasksDone: number;
    tasksPending: number;
    tasksFailed: number;
    lastActivityAt?: string;
  };
  files: AtlasFileNode[];
  tasks: AtlasTaskNode[];
}

interface FileAccumulator {
  path: string;
  changeCount: number;
  lastChangedAt?: string;
  lastChangedByTaskId?: string;
  lastChangedByTaskTitle?: string;
  contributingTaskIds: Set<string>;
}

interface TaskAccumulator {
  runCount: number;
  lastRunAt?: string;
  lastRunStatus?: 'done' | 'failed';
  changedFiles: Set<string>;
  title?: string;
}

// Append-only history is written in chronological order, so a later line is a
// more recent change. We compare ISO timestamps when present and otherwise let
// position win — guarding against the rare entry with a missing timestamp.
function isNewer(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return candidate >= current;
}

export function buildAtlasMap(input: {
  planTasks: AtlasPlanTask[];
  historyEntries: AtlasHistoryEntry[];
  now?: () => Date;
}): AtlasMap {
  const now = input.now ?? (() => new Date());
  const planById = new Map<string, AtlasPlanTask>();
  for (const task of input.planTasks) planById.set(task.id, task);

  const files = new Map<string, FileAccumulator>();
  const taskRuns = new Map<string, TaskAccumulator>();
  let lastActivityAt: string | undefined;

  for (const entry of input.historyEntries) {
    const taskId = entry.taskId ?? '';
    const ts = entry.timestamp;
    if (isNewer(ts, lastActivityAt)) lastActivityAt = ts;

    if (taskId) {
      let run = taskRuns.get(taskId);
      if (!run) {
        run = { runCount: 0, changedFiles: new Set<string>() };
        taskRuns.set(taskId, run);
      }
      run.runCount++;
      if (entry.taskTitle) run.title = entry.taskTitle;
      if (isNewer(ts, run.lastRunAt)) {
        run.lastRunAt = ts;
        run.lastRunStatus = entry.status;
      }
    }

    for (const filePath of entry.changedFiles ?? []) {
      if (!filePath) continue;
      let node = files.get(filePath);
      if (!node) {
        node = { path: filePath, changeCount: 0, contributingTaskIds: new Set<string>() };
        files.set(filePath, node);
      }
      node.changeCount++;
      if (taskId) {
        node.contributingTaskIds.add(taskId);
        taskRuns.get(taskId)?.changedFiles.add(filePath);
      }
      if (isNewer(ts, node.lastChangedAt)) {
        node.lastChangedAt = ts;
        node.lastChangedByTaskId = taskId || undefined;
        node.lastChangedByTaskTitle = entry.taskTitle;
      }
    }
  }

  const fileNodes: AtlasFileNode[] = Array.from(files.values())
    .map((node) => ({
      path: node.path,
      changeCount: node.changeCount,
      lastChangedAt: node.lastChangedAt,
      lastChangedByTaskId: node.lastChangedByTaskId,
      lastChangedByTaskTitle: node.lastChangedByTaskTitle,
      contributingTaskIds: Array.from(node.contributingTaskIds).sort(),
      planStatus: node.lastChangedByTaskId ? planById.get(node.lastChangedByTaskId)?.status : undefined,
    }))
    .sort((a, b) => {
      if (a.lastChangedAt && b.lastChangedAt && a.lastChangedAt !== b.lastChangedAt) {
        return a.lastChangedAt < b.lastChangedAt ? 1 : -1; // most recent first
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

  // Plan tasks first, in plan order, enriched with run history. Then any task
  // that has run history but is no longer in the plan (superseded or removed).
  const taskNodes: AtlasTaskNode[] = [];
  const seen = new Set<string>();
  for (const task of input.planTasks) {
    const run = taskRuns.get(task.id);
    seen.add(task.id);
    taskNodes.push({
      id: task.id,
      title: task.title,
      planStatus: task.status,
      target: task.target,
      anchors: task.anchors,
      runCount: run?.runCount ?? 0,
      lastRunAt: run?.lastRunAt,
      lastRunStatus: run?.lastRunStatus,
      changedFiles: run ? Array.from(run.changedFiles).sort() : [],
      inPlan: true,
      inHistory: Boolean(run),
    });
  }
  const orphanRuns = Array.from(taskRuns.entries())
    .filter(([id]) => !seen.has(id))
    .sort((a, b) => {
      const at = a[1].lastRunAt ?? '';
      const bt = b[1].lastRunAt ?? '';
      return at < bt ? 1 : at > bt ? -1 : 0;
    });
  for (const [id, run] of orphanRuns) {
    taskNodes.push({
      id,
      title: run.title ?? id,
      planStatus: undefined,
      target: undefined,
      anchors: [],
      runCount: run.runCount,
      lastRunAt: run.lastRunAt,
      lastRunStatus: run.lastRunStatus,
      changedFiles: Array.from(run.changedFiles).sort(),
      inPlan: false,
      inHistory: true,
    });
  }

  return {
    generatedAt: now().toISOString(),
    summary: {
      filesTracked: fileNodes.length,
      tasksTotal: input.planTasks.length,
      tasksDone: input.planTasks.filter((t) => t.status === 'done').length,
      tasksPending: input.planTasks.filter((t) => t.status === 'pending').length,
      tasksFailed: input.planTasks.filter((t) => t.status === 'failed').length,
      lastActivityAt,
    },
    files: fileNodes,
    tasks: taskNodes,
  };
}

// Parse IMPLEMENTATION_PLAN.md task lines and their indented anchor/target
// metadata. Mirrors the plan grammar the autonomy loop reads:
//   - [ ] task-id — Title
//       - anchor: src/file.ts
//       - target: src/file.ts
export function parsePlanTasks(raw: string): AtlasPlanTask[] {
  const tasks: AtlasPlanTask[] = [];
  let current: AtlasPlanTask | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const taskMatch = line.match(/^- \[(.)\] (\S+)\s*[—\-]\s*(.+)$/);
    if (taskMatch) {
      const marker = taskMatch[1];
      current = {
        id: taskMatch[2],
        title: taskMatch[3].trim(),
        status: marker === 'x' ? 'done' : marker === '!' ? 'failed' : 'pending',
        anchors: [],
      };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const anchorMatch = line.match(/^\s+- anchor:\s*(\S+)\s*$/);
    if (anchorMatch) current.anchors.push(anchorMatch[1]);
    const targetMatch = line.match(/^\s+- target:\s*(\S+)\s*$/);
    if (targetMatch) current.target = targetMatch[1];
  }
  return tasks;
}

async function readPlanTasks(projectDir: string): Promise<AtlasPlanTask[]> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    return parsePlanTasks(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readHistoryEntries(projectDir: string): Promise<AtlasHistoryEntry[]> {
  try {
    const raw = await fs.readFile(path.join(projectDir, '.forge-history.jsonl'), 'utf-8');
    const entries: AtlasHistoryEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as AtlasHistoryEntry); } catch { /* skip half-written tail */ }
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

export interface AtlasRouterOptions {
  projectDir: string;
}

// Read-only Atlas surface. Returns the synthesized project map. An
// un-planned / never-run workspace is a legitimate empty state (200 with empty
// arrays), not an error, matching the other autonomy read routes.
export function createAtlasRouter(opts: AtlasRouterOptions): express.Router {
  const router = express.Router();

  router.get('/api/atlas/map', async (_req, res) => {
    try {
      const [planTasks, historyEntries] = await Promise.all([
        readPlanTasks(opts.projectDir),
        readHistoryEntries(opts.projectDir),
      ]);
      res.json(buildAtlasMap({ planTasks, historyEntries }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
