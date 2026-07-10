import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createGoal,
  readGoal,
  listGoals,
  updateGoal,
  transitionGoal,
  setActiveGoal,
  getActiveGoalId,
  getActiveGoal,
} from './store';
import { Goal, GoalCheck } from './types';
import { _resetFileLocksForTest } from '../persistence/atomicFile';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goal-store-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const sampleCheck: GoalCheck = {
  id: 'c1',
  description: 'always passes',
  required: true,
  spec: { kind: 'command', command: 'node', args: ['-e', 'process.exit(0)'] },
};

describe('goal/store', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); _resetFileLocksForTest(); });
  afterEach(async () => { await cleanup(dir); });

  it('createGoal persists a draft goal and assigns ids/timestamps', async () => {
    const g = await createGoal(dir, { target: 'ship feature X' });
    expect(g.status).toBe('draft');
    expect(g.target).toBe('ship feature X');
    expect(g.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(g.createdAt).toBe(g.updatedAt);
    const round = await readGoal(dir, g.id);
    expect(round).toEqual(g);
  });

  it('readGoal returns null when the goal does not exist', async () => {
    expect(await readGoal(dir, 'nope')).toBeNull();
  });

  it('listGoals returns all goals sorted by createdAt', async () => {
    const a = await createGoal(dir, { target: 'a' }, new Date(1000));
    const b = await createGoal(dir, { target: 'b' }, new Date(2000));
    const c = await createGoal(dir, { target: 'c' }, new Date(1500));
    const list = await listGoals(dir);
    expect(list.map((g) => g.id)).toEqual([a.id, c.id, b.id]);
  });

  it('updateGoal applies mutation, bumps updatedAt, and persists', async () => {
    const g = await createGoal(dir, { target: 'x' }, new Date(1000));
    const later = new Date(5000);
    const next = await updateGoal(dir, g.id, (clone) => {
      clone.verification.push(sampleCheck);
      return clone;
    }, later);
    expect(next.updatedAt).toBe(later.toISOString());
    expect(next.verification).toHaveLength(1);
    const round = await readGoal(dir, g.id);
    expect(round?.verification).toHaveLength(1);
  });

  it('updateGoal does not mutate the on-disk goal when mutate returns null', async () => {
    const g = await createGoal(dir, { target: 'x' });
    const after = await updateGoal(dir, g.id, () => null);
    expect(after).toEqual(g);
  });

  it('updateGoal rejects illegal status transitions', async () => {
    const g = await createGoal(dir, { target: 'x' });
    // draft -> complete is not allowed
    await expect(updateGoal(dir, g.id, (c) => { c.status = 'complete'; return c; }))
      .rejects.toThrow(/Illegal status transition: draft -> complete/);
  });

  it('updateGoal refuses to change id or schemaVersion', async () => {
    const g = await createGoal(dir, { target: 'x' });
    await expect(updateGoal(dir, g.id, (c) => { c.id = 'tampered'; return c; }))
      .rejects.toThrow(/must not change id/);
    await expect(updateGoal(dir, g.id, (c) => { (c as Goal).schemaVersion = 99 as 1; return c; }))
      .rejects.toThrow(/must not change schemaVersion/);
  });

  it('updateGoal refuses to mutate terminal goals', async () => {
    const g = await createGoal(dir, { target: 'x' });
    await updateGoal(dir, g.id, (c) => { c.status = 'active'; return c; });
    await transitionGoal(dir, g.id, 'complete');
    await expect(updateGoal(dir, g.id, (c) => { c.target = 'y'; return c; }))
      .rejects.toThrow(/terminal state 'complete'/);
  });

  it('transitionGoal to active sets startedAt on first activation', async () => {
    const g = await createGoal(dir, { target: 'x' });
    const at = new Date(7777);
    const activated = await transitionGoal(dir, g.id, 'active', {}, at);
    expect(activated.startedAt).toBe(at.toISOString());
  });

  it('transitionGoal clears active pointer when goal goes terminal', async () => {
    const g = await createGoal(dir, { target: 'x' });
    await transitionGoal(dir, g.id, 'active');
    await setActiveGoal(dir, g.id);
    expect(await getActiveGoalId(dir)).toBe(g.id);
    await transitionGoal(dir, g.id, 'complete');
    expect(await getActiveGoalId(dir)).toBeNull();
  });

  it('setActiveGoal / getActiveGoal roundtrip and clear', async () => {
    const g = await createGoal(dir, { target: 'x' });
    expect(await getActiveGoal(dir)).toBeNull();
    await setActiveGoal(dir, g.id);
    const active = await getActiveGoal(dir);
    expect(active?.id).toBe(g.id);
    await setActiveGoal(dir, null);
    expect(await getActiveGoalId(dir)).toBeNull();
  });

  it('setActiveGoal rejects an unknown id', async () => {
    await expect(setActiveGoal(dir, 'no-such-goal')).rejects.toThrow(/goal not found/);
  });

  it('parallel updateGoal calls do not lose mutations (file-lock regression)', async () => {
    const g = await createGoal(dir, { target: 'concurrent' });
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) => updateGoal(dir, g.id, (clone) => {
        clone.verification.push({
          id: `c${i}`,
          description: `check ${i}`,
          required: false,
          spec: { kind: 'file_exists', path: `/tmp/${i}` },
        });
        return clone;
      })),
    );
    const final = await readGoal(dir, g.id);
    expect(final?.verification).toHaveLength(N);
    const ids = new Set(final!.verification.map((c) => c.id));
    expect(ids.size).toBe(N);
  });

  it('readGoal rejects a file with the wrong schema version', async () => {
    const g = await createGoal(dir, { target: 'x' });
    const file = path.join(dir, '.harness', 'goals', `${g.id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    raw.schemaVersion = 99;
    await fs.writeFile(file, JSON.stringify(raw));
    await expect(readGoal(dir, g.id)).rejects.toThrow(/Unsupported goal schema version 99/);
  });
});
