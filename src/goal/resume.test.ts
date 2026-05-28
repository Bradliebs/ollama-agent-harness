import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGoal, transitionGoal, setActiveGoal } from './store';
import { getResumableGoal, resumeGoal } from './resume';
import { _resetFileLocksForTest } from '../persistence/atomicFile';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goal-resume-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('goal/resume', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); _resetFileLocksForTest(); });
  afterEach(async () => { await cleanup(dir); });

  it('returns kind=none when no active goal is set', async () => {
    expect(await getResumableGoal(dir)).toEqual({ kind: 'none' });
  });

  it('returns kind=none when active goal is complete', async () => {
    const g = await createGoal(dir, { target: 't' });
    await transitionGoal(dir, g.id, 'active');
    await transitionGoal(dir, g.id, 'complete');
    // transitionGoal clears active pointer on terminal, so set it back
    // manually to prove the resume helper still returns 'none' on a terminal goal.
    await fs.writeFile(path.join(dir, '.harness', 'goals', 'active.json'), JSON.stringify({ activeId: g.id }));
    expect(await getResumableGoal(dir)).toEqual({ kind: 'none' });
  });

  it('returns kind=auto for an active goal (crash-resume scenario)', async () => {
    const g = await createGoal(dir, { target: 't' });
    await transitionGoal(dir, g.id, 'active');
    await setActiveGoal(dir, g.id);
    const res = await getResumableGoal(dir);
    expect(res).toMatchObject({ kind: 'auto' });
    if ('goal' in res) expect(res.goal.id).toBe(g.id);
  });

  it('returns kind=needs_ack for a paused goal', async () => {
    const g = await createGoal(dir, { target: 't' });
    await transitionGoal(dir, g.id, 'active');
    await transitionGoal(dir, g.id, 'paused', { pause: { reason: 'r', pausedAt: new Date().toISOString(), pausedBy: 'human' } });
    await setActiveGoal(dir, g.id);
    const res = await getResumableGoal(dir);
    expect(res).toMatchObject({ kind: 'needs_ack' });
  });

  it('returns kind=needs_ack for a blocked goal', async () => {
    const g = await createGoal(dir, { target: 't' });
    await transitionGoal(dir, g.id, 'active');
    await transitionGoal(dir, g.id, 'blocked', { block: { reason: 'r', blockedAt: new Date().toISOString(), needs: 'human' } });
    await setActiveGoal(dir, g.id);
    const res = await getResumableGoal(dir);
    expect(res).toMatchObject({ kind: 'needs_ack' });
  });

  it('resumeGoal moves paused → active and clears the pause patch', async () => {
    const g = await createGoal(dir, { target: 't' });
    await transitionGoal(dir, g.id, 'active');
    await transitionGoal(dir, g.id, 'paused', { pause: { reason: 'r', pausedAt: new Date().toISOString(), pausedBy: 'human' } });
    const resumed = await resumeGoal(dir, g.id);
    expect(resumed.status).toBe('active');
    expect(resumed.pause).toBeUndefined();
  });

  it('resumeGoal rejects when the goal is not paused', async () => {
    const g = await createGoal(dir, { target: 't' });
    await expect(resumeGoal(dir, g.id)).rejects.toThrow(/expected 'paused'/);
  });

  it('resumeGoal rejects when the goal id is unknown', async () => {
    await expect(resumeGoal(dir, 'no-such')).rejects.toThrow(/goal not found/);
  });
});
