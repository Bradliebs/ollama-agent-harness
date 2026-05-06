// Structured task store.
//
// JSON-persisted task lifecycle: pending → assigned → in_progress → blocked
// → review → done | failed | cancelled.
//
// Designed so sub-agents can self-report progress (task_progress tool) and
// the main agent / heartbeat can monitor stale tasks.
//
// Storage: .harness/tasks/tasks.json
//
// All mutations emit events via emitEvent so the WebSocket broadcaster
// notifies live UI clients.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'low' | 'normal' | 'high';

export interface TaskCheckIn {
  timestamp: string;
  progressPercent?: number;
  message: string;
  status?: TaskStatus;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  assigneeId?: string;
  parentTaskId?: string;
  dependsOn: string[];
  progressPercent: number;
  checkIns: TaskCheckIn[];
  tags: string[];
  /** Optional free-form metadata (e.g. linked session id). */
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigneeId?: string;
  parentTaskId?: string;
  dependsOn?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string;
  dependsOn?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

const STALE_CHECK_IN_MS = 30 * 60 * 1000;

function tasksFilePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'tasks', 'tasks.json');
}

async function readAll(projectDir: string): Promise<Task[]> {
  try {
    const raw = await fs.readFile(tasksFilePath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as { tasks?: Task[] };
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

async function writeAll(projectDir: string, tasks: Task[]): Promise<void> {
  const fp = tasksFilePath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify({ tasks }, null, 2), 'utf-8');
}

export async function listTasks(projectDir: string, filter: { status?: TaskStatus; assigneeId?: string } = {}): Promise<Task[]> {
  const tasks = await readAll(projectDir);
  return tasks.filter((task) => {
    if (filter.status && task.status !== filter.status) return false;
    if (filter.assigneeId && task.assigneeId !== filter.assigneeId) return false;
    return true;
  });
}

export async function getTask(projectDir: string, id: string): Promise<Task | undefined> {
  const tasks = await readAll(projectDir);
  return tasks.find((task) => task.id === id);
}

export async function createTask(projectDir: string, input: CreateTaskInput, now = new Date()): Promise<Task> {
  if (!input.title || !input.title.trim()) throw new Error('Task title is required');
  const task: Task = {
    id: crypto.randomUUID(),
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
    status: input.assigneeId ? 'assigned' : 'pending',
    priority: input.priority ?? 'normal',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    assigneeId: input.assigneeId,
    parentTaskId: input.parentTaskId,
    dependsOn: input.dependsOn ?? [],
    progressPercent: 0,
    checkIns: [],
    tags: input.tags ?? [],
    metadata: input.metadata,
  };
  const tasks = await readAll(projectDir);
  tasks.push(task);
  await writeAll(projectDir, tasks);
  await emitEvent(projectDir, 'task', 'task.created', { task }, 'system', task.id).catch(() => {});
  return task;
}

export async function updateTask(projectDir: string, id: string, input: UpdateTaskInput, now = new Date()): Promise<Task> {
  const tasks = await readAll(projectDir);
  const idx = tasks.findIndex((task) => task.id === id);
  if (idx === -1) throw new Error(`Task not found: ${id}`);
  const previous = tasks[idx];
  const updated: Task = {
    ...previous,
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() || undefined } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId || undefined } : {}),
    ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    updatedAt: now.toISOString(),
  };
  // Auto-assign status when assignee changes from undefined → defined.
  if (!previous.assigneeId && updated.assigneeId && updated.status === 'pending') {
    updated.status = 'assigned';
  }
  tasks[idx] = updated;
  await writeAll(projectDir, tasks);
  await emitEvent(projectDir, 'task', 'task.updated', { task: updated, previous }, 'system', updated.id).catch(() => {});
  return updated;
}

export async function recordCheckIn(
  projectDir: string,
  id: string,
  checkIn: { progressPercent?: number; message: string; status?: TaskStatus },
  now = new Date(),
): Promise<Task> {
  const tasks = await readAll(projectDir);
  const idx = tasks.findIndex((task) => task.id === id);
  if (idx === -1) throw new Error(`Task not found: ${id}`);
  const task = tasks[idx];
  const entry: TaskCheckIn = {
    timestamp: now.toISOString(),
    progressPercent: typeof checkIn.progressPercent === 'number'
      ? Math.max(0, Math.min(100, Math.round(checkIn.progressPercent)))
      : undefined,
    message: checkIn.message,
    status: checkIn.status,
  };
  task.checkIns.push(entry);
  if (entry.progressPercent !== undefined) task.progressPercent = entry.progressPercent;
  if (entry.status) task.status = entry.status;
  // Implicit transitions: any check-in advances pending/assigned to in_progress.
  if (task.status === 'pending' || task.status === 'assigned') task.status = 'in_progress';
  task.updatedAt = now.toISOString();
  tasks[idx] = task;
  await writeAll(projectDir, tasks);
  await emitEvent(projectDir, 'task', 'task.check_in', { taskId: id, checkIn: entry, task }, 'system', id).catch(() => {});
  return task;
}

export async function deleteTask(projectDir: string, id: string): Promise<boolean> {
  const tasks = await readAll(projectDir);
  const idx = tasks.findIndex((task) => task.id === id);
  if (idx === -1) return false;
  const [removed] = tasks.splice(idx, 1);
  await writeAll(projectDir, tasks);
  await emitEvent(projectDir, 'task', 'task.deleted', { task: removed }, 'system', id).catch(() => {});
  return true;
}

export interface StaleTaskReport {
  taskId: string;
  title: string;
  assigneeId?: string;
  lastActivityAt: string;
  staleForMs: number;
}

/** Identify in-progress tasks that have not checked in within STALE_CHECK_IN_MS. */
export async function detectStaleTasks(projectDir: string, now = new Date(), staleMs = STALE_CHECK_IN_MS): Promise<StaleTaskReport[]> {
  const tasks = await readAll(projectDir);
  const reports: StaleTaskReport[] = [];
  for (const task of tasks) {
    if (task.status !== 'in_progress') continue;
    const lastCheckIn = task.checkIns[task.checkIns.length - 1];
    const lastActivityAt = lastCheckIn?.timestamp ?? task.updatedAt;
    const elapsed = now.getTime() - Date.parse(lastActivityAt);
    if (elapsed > staleMs) {
      reports.push({ taskId: task.id, title: task.title, assigneeId: task.assigneeId, lastActivityAt, staleForMs: elapsed });
    }
  }
  return reports;
}

/** Summarize tasks for board-style UIs (tasks grouped by status with counts). */
export async function summarizeTasks(projectDir: string): Promise<Record<TaskStatus, number> & { total: number }> {
  const tasks = await readAll(projectDir);
  const summary: Record<TaskStatus, number> = {
    pending: 0,
    assigned: 0,
    in_progress: 0,
    blocked: 0,
    review: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) summary[task.status] += 1;
  return { ...summary, total: tasks.length };
}
