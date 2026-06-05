// Express router for structured tasks and the Kanban board.
//
// Extracted from server.ts as the second slice of audit Fix #7 (route-block
// extraction from the 11k-line server). Pattern mirrors goalRoutes.ts and
// identityRoutes.ts: the router takes projectDir as its only dependency and
// owns the small validation sets these routes share.

import express from 'express';
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

export interface TaskRoutesDeps {
  projectDir: string;
}

const VALID_TASK_STATUSES = new Set<TaskStatus>(['pending', 'assigned', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled']);
const VALID_TASK_PRIORITIES = new Set<TaskPriority>(['low', 'normal', 'high']);
const VALID_KANBAN_COLUMNS: ReadonlySet<KanbanColumn> = new Set<KanbanColumn>(['triage', 'doing', 'done']);

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
