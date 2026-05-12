// Agent-callable tools for the structured task store.
//
// Two tools:
//   task_manage   — create / list / update / cancel tasks
//   task_progress — sub-agent self-reports progress / status

import type { Tool, ToolResult } from '../types';
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

const VALID_STATUSES: TaskStatus[] = [
  'pending', 'assigned', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled',
];

const VALID_PRIORITIES: TaskPriority[] = ['low', 'normal', 'high'];

function projectDir(): string {
  return process.cwd();
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export const TaskManageTool: Tool = {
  name: 'task_manage',
  description: 'Create, list, update, or delete structured tasks tracked by the harness. Tasks have a lifecycle (pending → assigned → in_progress → blocked → review → done/failed/cancelled) and can be assigned to sub-agents.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'One of: create, list, get, update, delete, summary' },
      task_id: { type: 'string', description: 'Required for get, update, delete' },
      title: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', description: VALID_STATUSES.join(', ') },
      priority: { type: 'string', description: VALID_PRIORITIES.join(', ') },
      assignee_id: { type: 'string' },
      depends_on: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      filter_status: { type: 'string', description: 'For list: filter by status' },
      filter_assignee: { type: 'string', description: 'For list: filter by assignee id' },
    },
    required: ['action'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = asString(input.action) ?? '';
    try {
      switch (action) {
        case 'create': {
          const title = asString(input.title);
          if (!title) return fail('title is required for create');
          const priority = asString(input.priority) as TaskPriority | undefined;
          if (priority && !VALID_PRIORITIES.includes(priority)) return fail(`priority must be one of ${VALID_PRIORITIES.join(', ')}`);
          const task = await createTask(projectDir(), {
            title,
            description: asString(input.description),
            priority,
            assigneeId: asString(input.assignee_id),
            dependsOn: asStringArray(input.depends_on),
            tags: asStringArray(input.tags),
          });
          return ok(`Created task ${task.id}: ${task.title} (status=${task.status})`);
        }
        case 'list': {
          const statusFilter = asString(input.filter_status) as TaskStatus | undefined;
          if (statusFilter && !VALID_STATUSES.includes(statusFilter)) return fail(`status must be one of ${VALID_STATUSES.join(', ')}`);
          const tasks = await listTasks(projectDir(), {
            status: statusFilter,
            assigneeId: asString(input.filter_assignee),
          });
          if (tasks.length === 0) return ok('No tasks match the filter.');
          const lines = tasks.map((task) => `${task.id} [${task.status}] (${task.priority}) ${task.title}${task.assigneeId ? ` → ${task.assigneeId}` : ''} — ${task.progressPercent}%`);
          return ok(lines.join('\n'));
        }
        case 'get': {
          const id = asString(input.task_id);
          if (!id) return fail('task_id is required');
          const task = await getTask(projectDir(), id);
          if (!task) return fail(`Task not found: ${id}`);
          return ok(JSON.stringify(task, null, 2));
        }
        case 'update': {
          const id = asString(input.task_id);
          if (!id) return fail('task_id is required');
          const status = asString(input.status) as TaskStatus | undefined;
          if (status && !VALID_STATUSES.includes(status)) return fail(`status must be one of ${VALID_STATUSES.join(', ')}`);
          const priority = asString(input.priority) as TaskPriority | undefined;
          if (priority && !VALID_PRIORITIES.includes(priority)) return fail(`priority must be one of ${VALID_PRIORITIES.join(', ')}`);
          const task = await updateTask(projectDir(), id, {
            title: asString(input.title),
            description: asString(input.description),
            status,
            priority,
            assigneeId: asString(input.assignee_id),
            dependsOn: asStringArray(input.depends_on),
            tags: asStringArray(input.tags),
          });
          return ok(`Updated task ${task.id} (status=${task.status})`);
        }
        case 'delete': {
          const id = asString(input.task_id);
          if (!id) return fail('task_id is required');
          const removed = await deleteTask(projectDir(), id);
          return ok(removed ? `Deleted task ${id}` : `Task not found: ${id}`);
        }
        case 'summary': {
          const summary = await summarizeTasks(projectDir());
          return ok(JSON.stringify(summary, null, 2));
        }
        default:
          return fail(`Unknown action: ${action}. Use create, list, get, update, delete, summary.`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

export const TaskProgressTool: Tool = {
  name: 'task_progress',
  description: 'Report progress on a task. Sub-agents call this to record check-ins (percentage, status update, free-form message). The first check-in moves a task from pending/assigned to in_progress.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task being updated' },
      progress_percent: { type: 'number', description: '0-100, optional' },
      status: { type: 'string', description: 'Optional explicit status: in_progress, blocked, review, done, failed' },
      message: { type: 'string', description: 'Short status message (required)' },
    },
    required: ['task_id', 'message'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = asString(input.task_id);
    if (!id) return fail('task_id is required');
    const message = asString(input.message);
    if (!message) return fail('message is required');
    const status = asString(input.status) as TaskStatus | undefined;
    if (status && !VALID_STATUSES.includes(status)) return fail(`status must be one of ${VALID_STATUSES.join(', ')}`);
    const progressRaw = input.progress_percent;
    const progressPercent = typeof progressRaw === 'number' ? progressRaw : undefined;
    try {
      const task = await recordCheckIn(projectDir(), id, { progressPercent, message, status });
      return ok(`Check-in recorded on ${task.id} (status=${task.status}, progress=${task.progressPercent}%)`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(message: string): ToolResult {
  return { success: false, output: message, error: message };
}
