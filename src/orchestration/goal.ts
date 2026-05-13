// Goal Store — hierarchical goal/issue/task alignment.
//
// Goals are the mission-level objectives of a company. Each goal can have
// issues (milestones/epics), and each issue has tasks. This creates a
// traceability chain from any piece of work back to the company mission.
//
// Goals → Issues → Tasks (in taskStore)
//
// Storage: .harness/goals/<id>.json

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

// ─── Types ──────────────────────────────────────────────────────────

export type GoalStatus = 'active' | 'completed' | 'paused' | 'cancelled';
export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type IssuePriority = 'low' | 'medium' | 'high' | 'critical';

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description?: string;
  /** The measurable outcome that defines success. */
  successCriteria?: string;
  status: GoalStatus;
  /** Target completion date. */
  targetDate?: string;
  /** Parent goal (for sub-goals). */
  parentGoalId?: string;
  /** Agent primarily responsible for this goal. */
  ownerAgentId?: string;
  /** Progress percentage (0-100), computed from issues. */
  progressPercent: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: string;
  goalId: string;
  companyId: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: IssuePriority;
  /** Agent assigned to this issue. */
  assigneeAgentId?: string;
  /** IDs of tasks linked to this issue. */
  linkedTaskIds: string[];
  /** Progress percentage (0-100). */
  progressPercent: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGoalInput {
  companyId: string;
  title: string;
  description?: string;
  successCriteria?: string;
  targetDate?: string;
  parentGoalId?: string;
  ownerAgentId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string;
  successCriteria?: string;
  status?: GoalStatus;
  targetDate?: string;
  ownerAgentId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateIssueInput {
  goalId: string;
  companyId: string;
  title: string;
  description?: string;
  priority?: IssuePriority;
  assigneeAgentId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeAgentId?: string;
  linkedTaskIds?: string[];
  metadata?: Record<string, unknown>;
}

// ─── Storage Helpers ─────────────────────────────────────────────────

function goalsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'goals');
}

function goalFile(projectDir: string, id: string): string {
  return path.join(goalsDir(projectDir), `${id}.json`);
}

function issuesDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'goals', 'issues');
}

function issueFile(projectDir: string, id: string): string {
  return path.join(issuesDir(projectDir), `${id}.json`);
}

// ─── Goal CRUD ──────────────────────────────────────────────────────

export async function listGoals(projectDir: string, filter?: { companyId?: string; status?: GoalStatus }): Promise<Goal[]> {
  const dir = goalsDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const goals: Goal[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'issues') continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf-8');
      goals.push(normalizeGoal(JSON.parse(raw)));
    } catch { /* skip */ }
  }
  return goals
    .filter((g) => {
      if (filter?.companyId && g.companyId !== filter.companyId) return false;
      if (filter?.status && g.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getGoal(projectDir: string, id: string): Promise<Goal | undefined> {
  try {
    const raw = await fs.readFile(goalFile(projectDir, id), 'utf-8');
    return normalizeGoal(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function createGoal(projectDir: string, input: CreateGoalInput, now = new Date()): Promise<Goal> {
  if (!input.title?.trim()) throw new Error('Goal title is required.');
  if (!input.companyId) throw new Error('companyId is required.');

  const id = crypto.randomUUID();
  const goal: Goal = normalizeGoal({
    id,
    companyId: input.companyId,
    title: input.title.trim(),
    description: input.description?.trim(),
    successCriteria: input.successCriteria?.trim(),
    status: 'active',
    targetDate: input.targetDate,
    parentGoalId: input.parentGoalId,
    ownerAgentId: input.ownerAgentId,
    progressPercent: 0,
    metadata: input.metadata,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  await fs.mkdir(goalsDir(projectDir), { recursive: true });
  await fs.writeFile(goalFile(projectDir, id), JSON.stringify(goal, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'goal.created', { goal }, 'system', id).catch(() => {});
  return goal;
}

export async function updateGoal(projectDir: string, id: string, input: UpdateGoalInput, now = new Date()): Promise<Goal> {
  const existing = await getGoal(projectDir, id);
  if (!existing) throw new Error(`Goal not found: ${id}`);

  const updated: Goal = normalizeGoal({
    ...existing,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    id: existing.id,
    companyId: existing.companyId,
    updatedAt: now.toISOString(),
  });

  await fs.writeFile(goalFile(projectDir, id), JSON.stringify(updated, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'goal.updated', { goal: updated }, 'system', id).catch(() => {});
  return updated;
}

export async function deleteGoal(projectDir: string, id: string): Promise<boolean> {
  try {
    // Also delete all issues under this goal
    const issues = await listIssues(projectDir, { goalId: id });
    for (const issue of issues) {
      await deleteIssue(projectDir, issue.id);
    }
    await fs.unlink(goalFile(projectDir, id));
    await emitEvent(projectDir, 'orchestration', 'goal.deleted', { goalId: id }, 'system', id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ─── Issue CRUD ─────────────────────────────────────────────────────

export async function listIssues(projectDir: string, filter?: { goalId?: string; companyId?: string; status?: IssueStatus }): Promise<Issue[]> {
  const dir = issuesDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const issues: Issue[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf-8');
      issues.push(normalizeIssue(JSON.parse(raw)));
    } catch { /* skip */ }
  }
  return issues
    .filter((i) => {
      if (filter?.goalId && i.goalId !== filter.goalId) return false;
      if (filter?.companyId && i.companyId !== filter.companyId) return false;
      if (filter?.status && i.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getIssue(projectDir: string, id: string): Promise<Issue | undefined> {
  try {
    const raw = await fs.readFile(issueFile(projectDir, id), 'utf-8');
    return normalizeIssue(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function createIssue(projectDir: string, input: CreateIssueInput, now = new Date()): Promise<Issue> {
  if (!input.title?.trim()) throw new Error('Issue title is required.');
  if (!input.goalId) throw new Error('goalId is required.');

  const id = crypto.randomUUID();
  const issue: Issue = normalizeIssue({
    id,
    goalId: input.goalId,
    companyId: input.companyId,
    title: input.title.trim(),
    description: input.description?.trim(),
    status: 'open',
    priority: input.priority ?? 'medium',
    assigneeAgentId: input.assigneeAgentId,
    linkedTaskIds: [],
    progressPercent: 0,
    metadata: input.metadata,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  await fs.mkdir(issuesDir(projectDir), { recursive: true });
  await fs.writeFile(issueFile(projectDir, id), JSON.stringify(issue, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'issue.created', { issue }, 'system', id).catch(() => {});
  return issue;
}

export async function updateIssue(projectDir: string, id: string, input: UpdateIssueInput, now = new Date()): Promise<Issue> {
  const existing = await getIssue(projectDir, id);
  if (!existing) throw new Error(`Issue not found: ${id}`);

  const updated: Issue = normalizeIssue({
    ...existing,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    id: existing.id,
    goalId: existing.goalId,
    companyId: existing.companyId,
    updatedAt: now.toISOString(),
  });

  await fs.writeFile(issueFile(projectDir, id), JSON.stringify(updated, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'issue.updated', { issue: updated }, 'system', id).catch(() => {});
  return updated;
}

export async function deleteIssue(projectDir: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(issueFile(projectDir, id));
    await emitEvent(projectDir, 'orchestration', 'issue.deleted', { issueId: id }, 'system', id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ─── Progress Computation ───────────────────────────────────────────

/**
 * Recompute goal progress from its issues. Issues are weighted equally.
 */
export async function recomputeGoalProgress(projectDir: string, goalId: string): Promise<number> {
  const issues = await listIssues(projectDir, { goalId });
  if (issues.length === 0) return 0;
  const total = issues.reduce((sum, i) => sum + i.progressPercent, 0);
  return Math.round(total / issues.length);
}

/**
 * Recompute and persist a goal's progress percent based on its issues.
 * Returns the updated goal, or undefined if the goal does not exist.
 */
export async function computeGoalProgress(projectDir: string, goalId: string): Promise<Goal | undefined> {
  const existing = await getGoal(projectDir, goalId);
  if (!existing) return undefined;
  const progressPercent = await recomputeGoalProgress(projectDir, goalId);
  if (progressPercent === existing.progressPercent) return existing;
  const updated: Goal = normalizeGoal({
    ...existing,
    progressPercent,
    updatedAt: new Date().toISOString(),
  });
  await fs.writeFile(goalFile(projectDir, goalId), JSON.stringify(updated, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'goal.progress', { goalId, progressPercent }, 'system', goalId).catch(() => {});
  return updated;
}

/**
 * Update a goal's progress percent based on its issues.
 */
export async function refreshGoalProgress(projectDir: string, goalId: string): Promise<Goal | undefined> {
  return computeGoalProgress(projectDir, goalId);
}

// ─── Goal-to-Task Traceability ──────────────────────────────────────

/**
 * Build a traceability chain from a task all the way up to the company mission.
 * Returns the chain: Task → Issue → Goal → Company.
 */
export async function traceToCompany(projectDir: string, taskId: string): Promise<{
  task?: { id: string; title: string };
  issue?: Issue;
  goal?: Goal;
  companyId?: string;
} | null> {
  // Find the issue that links this task
  const allIssues = await listIssues(projectDir);
  const issue = allIssues.find((i) => i.linkedTaskIds.includes(taskId));
  if (!issue) return null;

  const goal = await getGoal(projectDir, issue.goalId);
  return {
    issue,
    goal,
    companyId: issue.companyId,
  };
}

// ─── Normalization ──────────────────────────────────────────────────

function normalizeGoal(partial: Partial<Goal> & { id: string }): Goal {
  return {
    id: partial.id,
    companyId: partial.companyId ?? '',
    title: partial.title ?? 'Untitled Goal',
    description: partial.description,
    successCriteria: partial.successCriteria,
    status: partial.status ?? 'active',
    targetDate: partial.targetDate,
    parentGoalId: partial.parentGoalId,
    ownerAgentId: partial.ownerAgentId,
    progressPercent: partial.progressPercent ?? 0,
    metadata: partial.metadata,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
  };
}

function normalizeIssue(partial: Partial<Issue> & { id: string }): Issue {
  return {
    id: partial.id,
    goalId: partial.goalId ?? '',
    companyId: partial.companyId ?? '',
    title: partial.title ?? 'Untitled Issue',
    description: partial.description,
    status: partial.status ?? 'open',
    priority: partial.priority ?? 'medium',
    assigneeAgentId: partial.assigneeAgentId,
    linkedTaskIds: partial.linkedTaskIds ?? [],
    progressPercent: partial.progressPercent ?? 0,
    metadata: partial.metadata,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
  };
}