// Goal alignment tree — Company Mission → Goals → Tasks.
//
// Goals provide traceability from every task back to the company mission.
// Goals can be decomposed into child tasks with dependency chains.
// Progress is rolled up from task completion percentages.
//
// Storage: `.harness/companies/<companyId>/goals.json`

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';
import { createTask, listTasks, type Task, type TaskPriority } from './taskStore';

// ─── Types ──────────────────────────────────────────────────────────

export type GoalStatus = 'active' | 'completed' | 'abandoned';
export type GoalPriority = 'low' | 'normal' | 'high' | 'critical';

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string;
  /** How this goal aligns with the company mission. */
  missionAlignment: string;
  status: GoalStatus;
  priority: GoalPriority;
  targetDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGoalInput {
  title: string;
  description: string;
  missionAlignment?: string;
  priority?: GoalPriority;
  targetDate?: string;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string;
  missionAlignment?: string;
  status?: GoalStatus;
  priority?: GoalPriority;
  targetDate?: string;
}

export interface GoalProgress {
  goalId: string;
  companyId: string;
  totalTasks: number;
  completedTasks: number;
  progressPercent: number;
  status: GoalStatus;
}

// ─── Persistence ────────────────────────────────────────────────────

function goalsFile(projectDir: string, companyId: string): string {
  return path.join(projectDir, '.harness', 'companies', companyId, 'goals.json');
}

async function readGoals(projectDir: string, companyId: string): Promise<Goal[]> {
  try {
    const raw = await fs.readFile(goalsFile(projectDir, companyId), 'utf-8');
    const parsed = JSON.parse(raw) as { goals?: Goal[] };
    return Array.isArray(parsed.goals) ? parsed.goals : [];
  } catch {
    return [];
  }
}

async function writeGoals(projectDir: string, companyId: string, goals: Goal[]): Promise<void> {
  const fp = goalsFile(projectDir, companyId);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify({ goals }, null, 2), 'utf-8');
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listGoals(projectDir: string, companyId: string, filter?: { status?: GoalStatus; priority?: GoalPriority }): Promise<Goal[]> {
  const goals = await readGoals(projectDir, companyId);
  return goals.filter((g) => {
    if (filter?.status && g.status !== filter.status) return false;
    if (filter?.priority && g.priority !== filter.priority) return false;
    return true;
  });
}

export async function getGoal(projectDir: string, companyId: string, id: string): Promise<Goal | undefined> {
  const goals = await readGoals(projectDir, companyId);
  return goals.find((g) => g.id === id);
}

export async function createGoal(projectDir: string, companyId: string, input: CreateGoalInput, now = new Date()): Promise<Goal> {
  if (!input.title?.trim()) throw new Error('Goal title is required.');
  const goal: Goal = {
    id: crypto.randomUUID(),
    companyId,
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    missionAlignment: input.missionAlignment?.trim() ?? '',
    status: 'active',
    priority: input.priority ?? 'normal',
    targetDate: input.targetDate,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const goals = await readGoals(projectDir, companyId);
  goals.push(goal);
  await writeGoals(projectDir, companyId, goals);
  await emitEvent(projectDir, 'service', 'goal.created', { goal }, 'system', goal.id).catch(() => {});
  return goal;
}

export async function updateGoal(projectDir: string, companyId: string, id: string, input: UpdateGoalInput, now = new Date()): Promise<Goal> {
  const goals = await readGoals(projectDir, companyId);
  const idx = goals.findIndex((g) => g.id === id);
  if (idx === -1) throw new Error(`Goal not found: ${id}`);
  const previous = goals[idx];
  const updated: Goal = {
    ...previous,
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.missionAlignment !== undefined ? { missionAlignment: input.missionAlignment.trim() } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.targetDate !== undefined ? { targetDate: input.targetDate || undefined } : {}),
    updatedAt: now.toISOString(),
  };
  goals[idx] = updated;
  await writeGoals(projectDir, companyId, goals);
  await emitEvent(projectDir, 'service', 'goal.updated', { goal: updated, previous }, 'system', updated.id).catch(() => {});
  return updated;
}

export async function deleteGoal(projectDir: string, companyId: string, id: string): Promise<boolean> {
  const goals = await readGoals(projectDir, companyId);
  const idx = goals.findIndex((g) => g.id === id);
  if (idx === -1) return false;
  const [removed] = goals.splice(idx, 1);
  await writeGoals(projectDir, companyId, goals);
  await emitEvent(projectDir, 'service', 'goal.deleted', { goal: removed }, 'system', id).catch(() => {});
  return true;
}

// ─── Goal decomposition ──────────────────────────────────────────────

/**
 * Decompose a goal into child tasks. Creates one task per prompt with the
 * goal's companyId and goalId set, and optional dependsOn chains.
 */
export async function decomposeGoal(
  projectDir: string,
  companyId: string,
  goalId: string,
  prompts: Array<{ title: string; description?: string; priority?: TaskPriority; dependsOn?: string[] }>,
  now = new Date(),
): Promise<Task[]> {
  const goal = await getGoal(projectDir, companyId, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);

  const tasks: Task[] = [];
  for (const prompt of prompts) {
    const task = await createTask(projectDir, {
      title: prompt.title,
      description: prompt.description,
      priority: prompt.priority ?? goal.priority === 'critical' ? 'high' : goal.priority === 'high' ? 'high' : 'normal',
      companyId,
      goalId,
      dependsOn: prompt.dependsOn,
    }, now);
    tasks.push(task);
  }
  return tasks;
}

// ─── Progress roll-up ────────────────────────────────────────────────

/**
 * Calculate progress for a goal by aggregating its child tasks.
 * Returns completion stats and an overall progress percentage.
 */
export async function getGoalProgress(projectDir: string, companyId: string, goalId: string): Promise<GoalProgress> {
  const goal = await getGoal(projectDir, companyId, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);

  const tasks = await listTasks(projectDir, { companyId, goalId });
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === 'done').length;
  const progressPercent = totalTasks > 0
    ? Math.round(tasks.reduce((sum, t) => sum + t.progressPercent, 0) / totalTasks)
    : 0;

  return {
    goalId,
    companyId,
    totalTasks,
    completedTasks,
    progressPercent,
    status: goal.status,
  };
}

/**
 * Roll up progress for all goals in a company.
 */
export async function listGoalProgress(projectDir: string, companyId: string): Promise<GoalProgress[]> {
  const goals = await listGoals(projectDir, companyId);
  const results: GoalProgress[] = [];
  for (const goal of goals) {
    results.push(await getGoalProgress(projectDir, companyId, goal.id));
  }
  return results;
}