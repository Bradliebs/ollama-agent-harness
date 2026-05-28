import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGoal, readGoal, transitionGoal, updateGoal, setActiveGoal } from './store';
import { runGoalLoop, type IterationOutcome, type GoalLoopEvent } from './loop';
import { GoalCheck, GoalConstraint } from './types';
import { _resetFileLocksForTest } from '../persistence/atomicFile';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goal-loop-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const passingCheck: GoalCheck = {
  id: 'pass-1',
  description: 'always passes',
  required: true,
  spec: { kind: 'command', command: 'node', args: ['-e', 'process.exit(0)'] },
};

const failingCheck: GoalCheck = {
  id: 'fail-1',
  description: 'always fails',
  required: true,
  spec: { kind: 'command', command: 'node', args: ['-e', 'process.exit(1)'] },
};

async function drain(gen: AsyncGenerator<GoalLoopEvent>): Promise<GoalLoopEvent[]> {
  const out: GoalLoopEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('runGoalLoop', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); _resetFileLocksForTest(); });
  afterEach(async () => { await cleanup(dir); });

  it('completes immediately when initial verification passes (already_satisfied)', async () => {
    const g = await createGoal(dir, { target: 'noop', verification: [passingCheck] });
    const runner = jest.fn(async (): Promise<IterationOutcome> => ({ action: 'nothing' }));
    const events = await drain(runGoalLoop({ projectDir: dir, goalId: g.id, runIteration: runner }));
    expect(runner).not.toHaveBeenCalled();
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('already_satisfied');
    const final = await readGoal(dir, g.id);
    expect(final?.status).toBe('complete');
  });

  it('transitions a draft goal to active before iterating', async () => {
    const g = await createGoal(dir, { target: 't', verification: [failingCheck] });
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: g.id,
      runIteration: async (): Promise<IterationOutcome> => ({ action: 'tried' }),
      defaultMaxIterations: 1,
    }));
    const transitions = events.filter((e) => e.type === 'transitioned') as Array<Extract<GoalLoopEvent, { type: 'transitioned' }>>;
    expect(transitions[0]).toMatchObject({ from: 'draft', to: 'active' });
  });

  it('reaches iteration_budget when checks never pass', async () => {
    const constraints: GoalConstraint[] = [{ id: 'b', description: 'iters', spec: { kind: 'budget', maxIterations: 3 } }];
    const g = await createGoal(dir, { target: 't', verification: [failingCheck], constraints });
    const runner = jest.fn(async (): Promise<IterationOutcome> => ({ action: 'tried', filesTouched: ['x.ts'] }));
    const events = await drain(runGoalLoop({ projectDir: dir, goalId: g.id, runIteration: runner }));
    expect(runner).toHaveBeenCalledTimes(3);
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('iteration_budget');
    expect(end.iterations).toBe(3);
    const final = await readGoal(dir, g.id);
    expect(final?.status).toBe('failed');
    expect(final?.iterations).toHaveLength(3);
    expect(final?.evidence.files).toEqual(['x.ts']);
  });

  it('succeeds after the iteration that flips verification to passing', async () => {
    // Verification: a file_exists check on a file the runner creates on iteration 2.
    const targetFile = path.join(dir, 'made-it.txt');
    const check: GoalCheck = { id: 'f', description: 'file made', required: true, spec: { kind: 'file_exists', path: targetFile } };
    const g = await createGoal(dir, { target: 'create file', verification: [check] });

    let n = 0;
    const runner = async (): Promise<IterationOutcome> => {
      n += 1;
      if (n === 2) await fs.writeFile(targetFile, 'done');
      return { action: `iteration ${n}`, filesTouched: [targetFile] };
    };

    const events = await drain(runGoalLoop({ projectDir: dir, goalId: g.id, runIteration: runner, defaultMaxIterations: 5 }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('success');
    expect(end.iterations).toBe(2);
    const final = await readGoal(dir, g.id);
    expect(final?.status).toBe('complete');
    expect(final?.verification[0].lastResult?.passed).toBe(true);
    // Check history is appended for both the initial run and each iteration.
    expect(final?.evidence.checkHistory.length).toBeGreaterThanOrEqual(3);
  });

  it('honours an external pause set between iterations', async () => {
    const g = await createGoal(dir, { target: 't', verification: [failingCheck] });
    const runner = async (_g: unknown, n: number): Promise<IterationOutcome> => {
      if (n === 1) {
        // Pause the goal from "outside" while iteration is finishing.
        await updateGoal(dir, g.id, (clone) => {
          clone.status = 'paused';
          clone.pause = { reason: 'user', pausedAt: new Date().toISOString(), pausedBy: 'human' };
          return clone;
        });
      }
      return { action: `it ${n}` };
    };
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: g.id, runIteration: runner, defaultMaxIterations: 5,
    }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('externally_paused');
    const final = await readGoal(dir, g.id);
    expect(final?.status).toBe('paused');
  });

  it('treats an already-terminal goal as not_runnable', async () => {
    const g = await createGoal(dir, { target: 't' });
    await transitionGoal(dir, g.id, 'active');
    await transitionGoal(dir, g.id, 'complete');
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: g.id,
      runIteration: async () => ({ action: 'no' }),
    }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('not_runnable');
  });

  it('returns goal_missing when the goal id is unknown', async () => {
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: 'nope',
      runIteration: async () => ({ action: 'no' }),
    }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('goal_missing');
  });

  it('returns externally_paused when goal starts paused', async () => {
    const g = await createGoal(dir, { target: 't' });
    await transitionGoal(dir, g.id, 'active');
    await transitionGoal(dir, g.id, 'paused', { pause: { reason: 'r', pausedAt: new Date().toISOString(), pausedBy: 'human' } });
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: g.id,
      runIteration: async () => ({ action: 'no' }),
    }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('externally_paused');
  });

  it('captures iteration errors as evidence and continues until budget', async () => {
    const g = await createGoal(dir, { target: 't', verification: [failingCheck] });
    const runner = async (): Promise<IterationOutcome> => { throw new Error('runner exploded'); };
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: g.id, runIteration: runner, defaultMaxIterations: 2,
    }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('iteration_budget');
    const final = await readGoal(dir, g.id);
    expect(final?.iterations.every((it) => it.notes.startsWith('error: runner exploded'))).toBe(true);
  });

  it('fails when the abort signal triggers between iterations', async () => {
    const constraints: GoalConstraint[] = [{ id: 'b', description: 'b', spec: { kind: 'budget', maxIterations: 10 } }];
    const g = await createGoal(dir, { target: 't', verification: [failingCheck], constraints });
    const ac = new AbortController();
    let calls = 0;
    const runner = async (): Promise<IterationOutcome> => {
      calls += 1;
      if (calls === 2) ac.abort();
      return { action: `iter ${calls}` };
    };
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: g.id, runIteration: runner, abortSignal: ac.signal,
    }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('externally_paused');
    expect(calls).toBe(2);
  });

  it('fails with time_budget when wall-clock exceeded', async () => {
    let virtual = 0;
    const now = () => new Date(virtual);
    const constraints: GoalConstraint[] = [{ id: 't', description: 'time', spec: { kind: 'time', maxDurationMs: 100 } }];
    const g = await createGoal(dir, { target: 't', verification: [failingCheck], constraints });
    const runner = async (): Promise<IterationOutcome> => {
      virtual += 60; // each iteration takes 60ms of virtual time
      return { action: `tick ${virtual}` };
    };
    const events = await drain(runGoalLoop({
      projectDir: dir, goalId: g.id, runIteration: runner, now, defaultMaxIterations: 100,
    }));
    const end = events.find((e) => e.type === 'loop_end') as Extract<GoalLoopEvent, { type: 'loop_end' }>;
    expect(end.reason).toBe('time_budget');
    const final = await readGoal(dir, g.id);
    expect(final?.status).toBe('failed');
  });

  it('tracks files touched and commits in evidence', async () => {
    const g = await createGoal(dir, { target: 't', verification: [failingCheck] });
    await setActiveGoal(dir, g.id);
    const runner = async (_g: unknown, n: number): Promise<IterationOutcome> => ({
      action: `i${n}`,
      filesTouched: [`a${n}.ts`, 'shared.ts'],
      commits: [`sha${n}`],
    });
    await drain(runGoalLoop({ projectDir: dir, goalId: g.id, runIteration: runner, defaultMaxIterations: 2 }));
    const final = await readGoal(dir, g.id);
    expect(final?.evidence.files.sort()).toEqual(['a1.ts', 'a2.ts', 'shared.ts']);
    expect(final?.evidence.commits.sort()).toEqual(['sha1', 'sha2']);
  });
});
