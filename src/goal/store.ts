// Active Goal — persistence store.
//
// Layout under <projectDir>/.harness/goals/:
//   <id>.json          — one file per goal
//   active.json        — { activeId: string | null }
//
// Atomic writes + per-file locks reuse the existing primitives so two
// async paths cannot lose updates.

import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import {
  Goal,
  GoalStatus,
  GOAL_SCHEMA_VERSION,
  NewGoalInput,
  makeGoal,
  isTransitionAllowed,
  isTerminal,
} from './types';

function goalsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'goals');
}

function goalPath(projectDir: string, id: string): string {
  return path.join(goalsDir(projectDir), `${id}.json`);
}

function activePath(projectDir: string): string {
  return path.join(goalsDir(projectDir), 'active.json');
}

async function ensureDir(projectDir: string): Promise<void> {
  await fs.mkdir(goalsDir(projectDir), { recursive: true });
}

function isGoalShape(value: unknown): value is Goal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.target === 'string' &&
    typeof v.status === 'string' &&
    Array.isArray(v.verification) &&
    Array.isArray(v.constraints) &&
    Array.isArray(v.iterations) &&
    typeof v.evidence === 'object' &&
    v.evidence !== null &&
    typeof v.schemaVersion === 'number'
  );
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function readGoal(projectDir: string, id: string): Promise<Goal | null> {
  try {
    const raw = await fs.readFile(goalPath(projectDir, id), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isGoalShape(parsed)) {
      throw new Error(`Malformed goal file for id=${id}`);
    }
    if (parsed.schemaVersion !== GOAL_SCHEMA_VERSION) {
      throw new Error(`Unsupported goal schema version ${parsed.schemaVersion} (expected ${GOAL_SCHEMA_VERSION}) for id=${id}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listGoals(projectDir: string): Promise<Goal[]> {
  await ensureDir(projectDir);
  const entries = await fs.readdir(goalsDir(projectDir));
  const out: Goal[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name === 'active.json') continue;
    const id = name.slice(0, -'.json'.length);
    const g = await readGoal(projectDir, id);
    if (g) out.push(g);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getActiveGoalId(projectDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(activePath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as { activeId?: string | null };
    return parsed.activeId ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function getActiveGoal(projectDir: string): Promise<Goal | null> {
  const id = await getActiveGoalId(projectDir);
  if (!id) return null;
  return readGoal(projectDir, id);
}

// ─── Writes ──────────────────────────────────────────────────────────

async function writeGoalLocked(projectDir: string, goal: Goal): Promise<void> {
  await ensureDir(projectDir);
  const file = goalPath(projectDir, goal.id);
  await withFileLock(file, () => atomicWriteFile(file, JSON.stringify(goal, null, 2)));
}

export async function createGoal(projectDir: string, input: NewGoalInput, now: Date = new Date()): Promise<Goal> {
  const id = randomUUID();
  const goal = makeGoal(input, id, now);
  await writeGoalLocked(projectDir, goal);
  return goal;
}

/**
 * Read-modify-write of a goal under its file lock. `mutate` receives a
 * deep clone; whatever it returns is what gets persisted. Returning
 * `null` means "no change" and skips the write.
 *
 * Status transitions are validated against the allowed-transition table.
 * Terminal-state goals are immutable except to be read back.
 */
export async function updateGoal(
  projectDir: string,
  id: string,
  mutate: (goal: Goal) => Goal | null,
  now: Date = new Date(),
): Promise<Goal> {
  await ensureDir(projectDir);
  const file = goalPath(projectDir, id);
  return withFileLock(file, async () => {
    const current = await readGoal(projectDir, id);
    if (!current) throw new Error(`Goal not found: ${id}`);
    if (isTerminal(current.status)) {
      throw new Error(`Goal ${id} is in terminal state '${current.status}' and cannot be updated`);
    }
    const clone = JSON.parse(JSON.stringify(current)) as Goal;
    const next = mutate(clone);
    if (next === null) return current;
    if (next.id !== current.id) throw new Error('updateGoal: mutate must not change id');
    if (next.schemaVersion !== current.schemaVersion) throw new Error('updateGoal: mutate must not change schemaVersion');
    if (!isTransitionAllowed(current.status, next.status)) {
      throw new Error(`Illegal status transition: ${current.status} -> ${next.status}`);
    }
    next.updatedAt = now.toISOString();
    if (current.status !== 'active' && next.status === 'active' && !next.startedAt) {
      next.startedAt = next.updatedAt;
    }
    await atomicWriteFile(file, JSON.stringify(next, null, 2));
    return next;
  });
}

export async function setActiveGoal(projectDir: string, id: string | null): Promise<void> {
  await ensureDir(projectDir);
  const file = activePath(projectDir);
  if (id !== null) {
    const exists = await readGoal(projectDir, id);
    if (!exists) throw new Error(`Cannot set active: goal not found: ${id}`);
  }
  await withFileLock(file, () => atomicWriteFile(file, JSON.stringify({ activeId: id }, null, 2)));
}

/**
 * Transition a goal's status. Validates the transition and clears the
 * active pointer if the goal is being moved to a terminal state.
 */
export async function transitionGoal(
  projectDir: string,
  id: string,
  to: GoalStatus,
  patch: Partial<Pick<Goal, 'pause' | 'block' | 'completionVerdict'>> = {},
  now: Date = new Date(),
): Promise<Goal> {
  const next = await updateGoal(projectDir, id, (g) => {
    g.status = to;
    if (to === 'paused' && patch.pause) g.pause = patch.pause;
    if (to !== 'paused') g.pause = undefined;
    if (to === 'blocked' && patch.block) g.block = patch.block;
    if (to !== 'blocked') g.block = undefined;
    if (to === 'complete' && patch.completionVerdict) g.completionVerdict = patch.completionVerdict;
    return g;
  }, now);
  if (isTerminal(to)) {
    const active = await getActiveGoalId(projectDir);
    if (active === id) await setActiveGoal(projectDir, null);
  }
  return next;
}
