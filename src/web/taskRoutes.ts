// Express router for structured tasks and the Kanban board.
//
// Extracted from server.ts as the second slice of audit Fix #7 (route-block
// extraction from the 11k-line server). Pattern mirrors goalRoutes.ts and
// identityRoutes.ts: the router takes projectDir as its only dependency and
// owns the small validation sets these routes share.

import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildTaskContract } from '../core/taskContractBuilder';
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  recordCheckIn,
  summarizeTasks,
  updateTask,
  type TaskPriority,
  type TaskStatus,
} from '../services/taskStore';
import {
  groupTasksByColumn,
  promoteTriageToPlan,
  withKanbanTag,
  type KanbanColumn,
} from '../services/kanbanBridge';
import type { TaskContract } from '../types/taskContract';

export interface TaskRoutesDeps {
  projectDir: string;
}

const VALID_TASK_STATUSES = new Set<TaskStatus>(['pending', 'assigned', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled']);
const VALID_TASK_PRIORITIES = new Set<TaskPriority>(['low', 'normal', 'high']);
const VALID_KANBAN_COLUMNS: ReadonlySet<KanbanColumn> = new Set<KanbanColumn>(['triage', 'doing', 'done']);
const execFileAsync = promisify(execFile);

interface CodexTaskMetadata {
  codex?: {
    contract?: TaskContract;
    status?: string;
    createdAt?: string;
    diffBase?: string;
  };
}

interface GitDiffSummary {
  available: boolean;
  status: string[];
  changedFiles: string[];
  stat: string;
  patchPreview: string;
  truncated: boolean;
  error?: string;
}

export function createTaskRoutesRouter(deps: TaskRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  // ─── Tasks ──────────────────────────────────────────────────────────
  // Structured task lifecycle. Mutations also emit events through the event
  // store so live WebSocket clients refresh without polling.

  router.get('/api/tasks', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status as TaskStatus : undefined;
      if (status && !VALID_TASK_STATUSES.has(status)) { res.status(400).json({ error: 'Invalid status filter.' }); return; }
      const assigneeId = typeof req.query.assignee === 'string' ? req.query.assignee : undefined;
      const tasks = await listTasks(projectDir, { status, assigneeId });
      const summary = await summarizeTasks(projectDir);
      res.json({ tasks, summary });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/tasks/:id', async (req, res) => {
    try {
      const task = await getTask(projectDir, req.params.id);
      if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
      res.json({ task });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/tasks', async (req, res) => {
    try {
      const { title, description, priority, assigneeId, parentTaskId, dependsOn, tags, metadata } = req.body ?? {};
      if (!title || typeof title !== 'string') { res.status(400).json({ error: 'title is required.' }); return; }
      if (priority && !VALID_TASK_PRIORITIES.has(priority)) { res.status(400).json({ error: 'Invalid priority.' }); return; }
      const task = await createTask(projectDir, {
        title, description, priority, assigneeId, parentTaskId,
        dependsOn: Array.isArray(dependsOn) ? dependsOn : undefined,
        tags: Array.isArray(tags) ? tags : undefined,
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
      });
      res.json({ task });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/api/tasks/:id', async (req, res) => {
    try {
      const { title, description, status, priority, assigneeId, dependsOn, tags, metadata } = req.body ?? {};
      if (status && !VALID_TASK_STATUSES.has(status)) { res.status(400).json({ error: 'Invalid status.' }); return; }
      if (priority && !VALID_TASK_PRIORITIES.has(priority)) { res.status(400).json({ error: 'Invalid priority.' }); return; }
      const task = await updateTask(projectDir, req.params.id, {
        title, description, status, priority, assigneeId,
        dependsOn: Array.isArray(dependsOn) ? dependsOn : undefined,
        tags: Array.isArray(tags) ? tags : undefined,
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
      });
      res.json({ task });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.startsWith('Task not found') ? 404 : 500).json({ error: message });
    }
  });

  router.post('/api/tasks/:id/check-in', async (req, res) => {
    try {
      const { progressPercent, message, status } = req.body ?? {};
      if (typeof message !== 'string' || !message.trim()) { res.status(400).json({ error: 'message is required.' }); return; }
      if (status && !VALID_TASK_STATUSES.has(status)) { res.status(400).json({ error: 'Invalid status.' }); return; }
      const task = await recordCheckIn(projectDir, req.params.id, {
        progressPercent: typeof progressPercent === 'number' ? progressPercent : undefined,
        message,
        status: status as TaskStatus | undefined,
      });
      res.json({ task });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      res.status(errMsg.startsWith('Task not found') ? 404 : 500).json({ error: errMsg });
    }
  });

  router.delete('/api/tasks/:id', async (req, res) => {
    try {
      const removed = await deleteTask(projectDir, req.params.id);
      if (!removed) { res.status(404).json({ error: 'Task not found.' }); return; }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ─── Codex-style task mode ─────────────────────────────────────────
  // A thin product layer over the existing task store + deterministic task
  // contract builder. This does not start background execution yet; it creates
  // a trackable coding task with explicit constraints, validation, and diff
  // visibility so a later runner has a durable contract to execute against.

  router.post('/api/codex/tasks', async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) { res.status(400).json({ error: 'prompt is required.' }); return; }
      const priority = req.body?.priority as TaskPriority | undefined;
      if (priority && !VALID_TASK_PRIORITIES.has(priority)) { res.status(400).json({ error: 'Invalid priority.' }); return; }
      const validation = stringArray(req.body?.validation);
      const allowedPaths = stringArray(req.body?.allowedPaths);
      const blockedPaths = stringArray(req.body?.blockedPaths);
      const approvalRequired = typeof req.body?.approvalRequired === 'boolean' ? req.body.approvalRequired : undefined;
      const contract = buildTaskContract(prompt, {
        ...(validation ? { validation } : {}),
        ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
        ...(blockedPaths ? { extra_blocked_paths: blockedPaths } : {}),
        ...(approvalRequired !== undefined ? { approval_required: approvalRequired } : {}),
      });
      const now = new Date().toISOString();
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : contract.goal.slice(0, 100);
      const task = await createTask(projectDir, {
        title,
        description: prompt,
        priority: priority ?? (contract.high_risk ? 'high' : 'normal'),
        tags: Array.from(new Set(['codex', `mode:${contract.mode}`, ...(Array.isArray(req.body?.tags) ? req.body.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [])])),
        metadata: {
          codex: {
            contract,
            status: 'ready',
            createdAt: now,
            diffBase: 'HEAD',
          },
        },
        executionPolicy: contract.approval_required ? 'require_approval' : 'auto',
      });
      res.json({ task, contract, next: { statusUrl: `/api/codex/tasks/${encodeURIComponent(task.id)}/status`, diffUrl: `/api/codex/tasks/${encodeURIComponent(task.id)}/diff` } });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/codex/tasks/:id/status', async (req, res) => {
    try {
      const task = await getTask(projectDir, req.params.id);
      if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
      const contract = extractCodexContract(task.metadata);
      const diff = await collectGitDiff(projectDir, 6000);
      res.json({
        task,
        contract,
        codex: (task.metadata as CodexTaskMetadata | undefined)?.codex ?? null,
        diff,
        lifecycle: codexLifecycle(task.status),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/codex/tasks/:id/diff', async (req, res) => {
    try {
      const task = await getTask(projectDir, req.params.id);
      if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
      const maxPatchChars = Number.isFinite(Number(req.query.maxPatchChars))
        ? Math.max(0, Math.min(50_000, Math.floor(Number(req.query.maxPatchChars))))
        : 20_000;
      res.json({ taskId: task.id, diff: await collectGitDiff(projectDir, maxPatchChars) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ─── Kanban board ───────────────────────────────────────────────────
  // Thin surface over taskStore + kanbanBridge. Moving a card into the
  // triage column also promotes the task into IMPLEMENTATION_PLAN.md so
  // the autonomy loop picks it up on the next iteration.

  router.get('/api/kanban/board', async (_req, res) => {
    try {
      const tasks = await listTasks(projectDir);
      const board = groupTasksByColumn(tasks);
      res.json(board);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/kanban/move', async (req, res) => {
    try {
      const { taskId, column } = req.body ?? {};
      if (typeof taskId !== 'string' || !taskId.trim()) { res.status(400).json({ error: 'taskId is required.' }); return; }
      if (typeof column !== 'string' || !VALID_KANBAN_COLUMNS.has(column as KanbanColumn)) {
        res.status(400).json({ error: 'Invalid column. Must be triage, doing, or done.' });
        return;
      }
      const existing = await getTask(projectDir, taskId);
      if (!existing) { res.status(404).json({ error: 'Task not found.' }); return; }
      const nextTags = withKanbanTag(existing.tags, column as KanbanColumn);
      const task = await updateTask(projectDir, taskId, { tags: nextTags });
      let promoted = null;
      if (column === 'triage') {
        promoted = await promoteTriageToPlan([task], { projectDir });
      }
      res.json({ moved: true, task, promoted });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.startsWith('Task not found') ? 404 : 500).json({ error: message });
    }
  });

  return router;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => String(item).trim()).filter(Boolean).slice(0, 50);
  return items.length > 0 ? items : undefined;
}

function extractCodexContract(metadata: unknown): TaskContract | null {
  const codex = (metadata as CodexTaskMetadata | undefined)?.codex;
  return codex?.contract ?? null;
}

function codexLifecycle(status: TaskStatus): { phase: string; blocked: boolean; terminal: boolean } {
  if (status === 'pending' || status === 'assigned') return { phase: 'ready', blocked: false, terminal: false };
  if (status === 'in_progress') return { phase: 'running', blocked: false, terminal: false };
  if (status === 'review') return { phase: 'review', blocked: false, terminal: false };
  if (status === 'blocked') return { phase: 'blocked', blocked: true, terminal: false };
  if (status === 'done') return { phase: 'done', blocked: false, terminal: true };
  if (status === 'failed') return { phase: 'failed', blocked: false, terminal: true };
  return { phase: 'cancelled', blocked: false, terminal: true };
}

async function collectGitDiff(projectDir: string, maxPatchChars: number): Promise<GitDiffSummary> {
  const status = await runGit(projectDir, ['status', '--short']);
  if (!status.ok) {
    return { available: false, status: [], changedFiles: [], stat: '', patchPreview: '', truncated: false, error: status.error };
  }
  const names = await runGit(projectDir, ['diff', '--name-only']);
  const stat = await runGit(projectDir, ['diff', '--stat']);
  const patch: { ok: true; output: string } | { ok: false; error: string } = maxPatchChars > 0
    ? await runGit(projectDir, ['diff', '--'])
    : { ok: true, output: '' };
  const patchText = patch.ok ? patch.output : '';
  const summary: GitDiffSummary = {
    available: true,
    status: lines(status.output),
    changedFiles: names.ok ? lines(names.output) : [],
    stat: stat.ok ? stat.output.trim() : '',
    patchPreview: patchText.slice(0, maxPatchChars),
    truncated: patchText.length > maxPatchChars,
  };
  if (!patch.ok) summary.error = patch.error;
  return summary;
}

async function runGit(projectDir: string, args: string[]): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const result = await execFileAsync('git', ['-C', projectDir, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return { ok: true, output: String(result.stdout ?? '') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
