/**
 * Tests for kanbanBridge — task ↔ column mapping and triage→plan promotion.
 */
import * as path from 'node:path';
import {
  groupTasksByColumn,
  inferKindFromTags,
  promoteTriageToPlan,
  taskToColumn,
  taskToPlanTask,
  withKanbanTag,
} from './kanbanBridge';
import type { Task } from './taskStore';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-' + Math.random().toString(36).slice(2, 8),
    title: 'A task',
    status: 'pending',
    priority: 'normal',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dependsOn: [],
    progressPercent: 0,
    checkIns: [],
    tags: [],
    ...overrides,
  };
}

const REPO = path.resolve('/repo');
const PLAN = path.resolve(REPO, 'IMPLEMENTATION_PLAN.md');

function makeFakeIo(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    io: {
      readFile: async (p: string) => {
        if (!store.has(p)) throw new Error('ENOENT');
        return store.get(p)!;
      },
      appendFile: async (p: string, data: string) => { store.set(p, (store.get(p) ?? '') + data); },
      writeFile: async (p: string, data: string) => { store.set(p, data); },
      access: async (p: string) => { if (!store.has(p)) throw new Error('ENOENT'); },
    },
  };
}

describe('taskToColumn', () => {
  it('falls back to status: pending → triage', () => {
    expect(taskToColumn(makeTask({ status: 'pending' }))).toBe('triage');
  });

  it('falls back to status: in_progress → doing', () => {
    expect(taskToColumn(makeTask({ status: 'in_progress' }))).toBe('doing');
  });

  it('falls back to status: done → done', () => {
    expect(taskToColumn(makeTask({ status: 'done' }))).toBe('done');
    expect(taskToColumn(makeTask({ status: 'failed' }))).toBe('done');
    expect(taskToColumn(makeTask({ status: 'cancelled' }))).toBe('done');
  });

  it('explicit kanban:* tags win over status', () => {
    expect(taskToColumn(makeTask({ status: 'pending', tags: ['kanban:doing'] }))).toBe('doing');
    expect(taskToColumn(makeTask({ status: 'in_progress', tags: ['kanban:triage'] }))).toBe('triage');
    expect(taskToColumn(makeTask({ status: 'done', tags: ['kanban:doing'] }))).toBe('doing');
  });
});

describe('groupTasksByColumn', () => {
  it('partitions tasks into 3 columns', () => {
    const board = groupTasksByColumn([
      makeTask({ title: 'A', status: 'pending' }),
      makeTask({ title: 'B', status: 'in_progress' }),
      makeTask({ title: 'C', status: 'done' }),
      makeTask({ title: 'D', tags: ['kanban:doing'], status: 'pending' }),
    ]);
    expect(board.triage.map((t) => t.title)).toEqual(['A']);
    expect(board.doing.map((t) => t.title)).toEqual(['B', 'D']);
    expect(board.done.map((t) => t.title)).toEqual(['C']);
  });
});

describe('withKanbanTag', () => {
  it('replaces any existing kanban:* tag', () => {
    expect(withKanbanTag(['kanban:triage', 'priority:high'], 'doing')).toEqual(['priority:high', 'kanban:doing']);
    expect(withKanbanTag([], 'done')).toEqual(['kanban:done']);
    expect(withKanbanTag(undefined, 'triage')).toEqual(['kanban:triage']);
  });
});

describe('inferKindFromTags', () => {
  it('returns the matching kind or undefined', () => {
    expect(inferKindFromTags(['kind:research'])).toBe('research');
    expect(inferKindFromTags(['kind:external', 'kanban:triage'])).toBe('external');
    expect(inferKindFromTags(['kanban:triage'])).toBeUndefined();
  });
});

describe('taskToPlanTask', () => {
  it('preserves slug-shaped ids', () => {
    const planTask = taskToPlanTask(makeTask({ id: 'build-wiki', title: 'Build the wiki' }));
    expect(planTask).toMatchObject({ id: 'build-wiki', title: 'Build the wiki' });
  });

  it('slugifies non-slug ids from the title', () => {
    const planTask = taskToPlanTask(makeTask({ id: 'a8f3-xx_invalid!', title: 'Build the WIKI today' }));
    expect(planTask.id).toBe('build-the-wiki-today');
  });

  it('picks up anchor:* tags', () => {
    const planTask = taskToPlanTask(makeTask({
      id: 'a-task',
      title: 'A task',
      tags: ['anchor:src/foo.ts', 'anchor:src/bar.ts', 'kanban:triage'],
    }));
    expect(planTask.anchors).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('passes kind through from kind:* tag', () => {
    const planTask = taskToPlanTask(makeTask({
      id: 'a-task',
      title: 'Investigate X',
      tags: ['kind:research'],
    }));
    expect(planTask.kind).toBe('research');
  });
});

describe('promoteTriageToPlan', () => {
  it('appends only triage-column tasks and is idempotent', async () => {
    const fake = makeFakeIo();
    const tasks: Task[] = [
      makeTask({ id: 'in-triage-1', title: 'First triage', status: 'pending' }),
      makeTask({ id: 'doing-task', title: 'Already doing', status: 'in_progress' }),
      makeTask({ id: 'in-triage-2', title: 'Second triage', status: 'pending', tags: ['kind:research'] }),
    ];

    const r1 = await promoteTriageToPlan(tasks, { projectDir: REPO, io: fake.io });
    expect(r1.mutated).toBe(true);
    expect(r1.appended.map((t) => t.id).sort()).toEqual(['in-triage-1', 'in-triage-2']);
    expect(r1.skipped).toEqual([]);

    const plan = fake.store.get(PLAN)!;
    expect(plan).toContain('# Implementation Plan');
    expect(plan).toContain('- [ ] in-triage-1 — First triage');
    expect(plan).toContain('- [ ] in-triage-2 — Second triage');
    expect(plan).toContain('  - kind: research');
    expect(plan).not.toContain('doing-task'); // doing column was skipped

    // Idempotent: second run appends nothing
    const r2 = await promoteTriageToPlan(tasks, { projectDir: REPO, io: fake.io });
    expect(r2.mutated).toBe(false);
    expect(r2.appended).toEqual([]);
    expect(r2.skipped.map((t) => t.id).sort()).toEqual(['in-triage-1', 'in-triage-2']);
  });

  it('creates the plan file when missing', async () => {
    const fake = makeFakeIo();
    const tasks = [makeTask({ id: 'only-task', title: 'Only one' })];
    const r = await promoteTriageToPlan(tasks, { projectDir: REPO, io: fake.io });
    expect(r.mutated).toBe(true);
    const plan = fake.store.get(PLAN)!;
    expect(plan.startsWith('# Implementation Plan\n')).toBe(true);
  });

  it('returns no-op when no triage tasks exist', async () => {
    const fake = makeFakeIo();
    const tasks = [makeTask({ id: 'x', status: 'in_progress' })];
    const r = await promoteTriageToPlan(tasks, { projectDir: REPO, io: fake.io });
    expect(r.mutated).toBe(false);
    expect(r.appended).toEqual([]);
    expect(fake.store.has(PLAN)).toBe(false);
  });

  it('respects --plan equivalent: custom planPath', async () => {
    const fake = makeFakeIo();
    const customPath = path.resolve(REPO, 'side-plan.md');
    const tasks = [makeTask({ id: 'x', title: 'X' })];
    await promoteTriageToPlan(tasks, { projectDir: REPO, planPath: 'side-plan.md', io: fake.io });
    expect(fake.store.has(customPath)).toBe(true);
    expect(fake.store.has(PLAN)).toBe(false);
  });
});
