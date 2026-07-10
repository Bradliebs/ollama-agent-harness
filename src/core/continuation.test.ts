import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyDecomposition,
  classifyContinuation,
  clearContinuationState,
  decomposeFailedTask,
  readContinuationRequest,
  readContinuationState,
  recordContinuation,
  serializePlanTasks,
  writeContinuationRequest,
  type ContinuationRequest,
  type ContinuationTask,
} from './continuation';

function task(id: string, status: ContinuationTask['status'], extra: Partial<ContinuationTask> = {}): ContinuationTask {
  return { id, title: `Task ${id}`, status, anchors: [], ...extra };
}

describe('classifyContinuation', () => {
  const base = { continuationsUsed: 0, maxContinuations: 3 };

  it('stops on hard error / aborted regardless of remaining work', () => {
    for (const endReason of ['error', 'aborted'] as const) {
      const d = classifyContinuation({ ...base, endReason, tasks: [task('a', 'pending')] });
      expect(d.action).toBe('stop');
      expect(d.followOnTasks).toEqual([]);
    }
  });

  it('stops on graceful shutdown (user asked to stop)', () => {
    const d = classifyContinuation({ ...base, endReason: 'graceful-shutdown', tasks: [task('a', 'pending')] });
    expect(d.action).toBe('stop');
  });

  it('stops when all tasks are done', () => {
    const d = classifyContinuation({ ...base, endReason: 'all-tasks-complete', tasks: [task('a', 'done')] });
    expect(d.action).toBe('stop');
    expect(d.remainingTasks).toEqual([]);
  });

  it('stops when the meta-budget is exhausted', () => {
    const d = classifyContinuation({
      endReason: 'finished-with-failures',
      tasks: [task('a', 'failed')],
      continuationsUsed: 3,
      maxContinuations: 3,
    });
    expect(d.action).toBe('stop');
    expect(d.reason).toMatch(/Meta-budget exhausted/);
  });

  it('stops when continuation is disabled (maxContinuations <= 0)', () => {
    const d = classifyContinuation({ endReason: 'time-budget-exhausted', tasks: [task('a', 'pending')], continuationsUsed: 0, maxContinuations: 0 });
    expect(d.action).toBe('stop');
  });

  it('continues on time-budget / blocked / finished-with-failures when budget remains, resetting failed->pending', () => {
    for (const endReason of ['time-budget-exhausted', 'iteration-budget-exhausted', 'blocked-by-failed-prerequisite', 'finished-with-failures'] as const) {
      const d = classifyContinuation({
        ...base,
        endReason,
        tasks: [task('a', 'done'), task('b', 'failed'), task('c', 'pending')],
      });
      expect(d.action).toBe('continue');
      expect(d.remainingTasks.map((t) => t.id)).toEqual(['b', 'c']);
      // failed 'b' reset to pending for a fresh per-task retry budget.
      expect(d.followOnTasks.find((t) => t.id === 'b')!.status).toBe('pending');
      expect(d.followOnTasks.find((t) => t.id === 'c')!.status).toBe('pending');
    }
  });

  it('does not mutate the input tasks when resetting failed->pending', () => {
    const tasks = [task('b', 'failed')];
    classifyContinuation({ ...base, endReason: 'finished-with-failures', tasks });
    expect(tasks[0].status).toBe('failed');
  });
});

describe('decomposeFailedTask / applyDecomposition', () => {
  it('derives collision-free ids and inherits anchors/target/kind', () => {
    const parent = task('big', 'failed', { anchors: ['a.ts', 'b.ts'], target: 'a.ts', kind: 'code' });
    const subs = decomposeFailedTask(parent, ['Step one', '  Step two  ', '']);
    expect(subs.map((s) => s.id)).toEqual(['big-1', 'big-2']);
    expect(subs[0].anchors).toEqual(['a.ts', 'b.ts']);
    expect(subs[0].target).toBe('a.ts');
    expect(subs[0].kind).toBe('code');
    expect(subs[1].title).toBe('Step two');
    expect(subs.every((s) => s.status === 'pending')).toBe(true);
  });

  it('applyDecomposition replaces the target task in place', () => {
    const tasks = [task('x', 'done'), task('big', 'failed'), task('y', 'pending')];
    const out = applyDecomposition(tasks, 'big', ['one', 'two']);
    expect(out.map((t) => t.id)).toEqual(['x', 'big-1', 'big-2', 'y']);
  });

  it('applyDecomposition is a no-op for an unknown id or empty sub-titles', () => {
    const tasks = [task('big', 'failed')];
    expect(applyDecomposition(tasks, 'nope', ['one'])).toBe(tasks);
    expect(applyDecomposition(tasks, 'big', ['  '])).toBe(tasks);
  });
});

describe('serializePlanTasks', () => {
  it('round-trips the plan grammar (markers, anchors, target, non-default kind)', () => {
    const out = serializePlanTasks([
      task('a', 'done'),
      task('b', 'failed', { anchors: ['src/x.ts'], target: 'src/x.ts' }),
      task('c', 'pending', { kind: 'research' }),
      task('d', 'pending', { kind: 'code' }),
    ]);
    expect(out).toContain('- [x] a — Task a');
    expect(out).toContain('- [!] b — Task b');
    expect(out).toContain('  - anchor: src/x.ts');
    expect(out).toContain('  - target: src/x.ts');
    expect(out).toContain('- [ ] c — Task c');
    expect(out).toContain('  - kind: research');
    // default kind 'code' is omitted, matching writePlan.
    expect(out).not.toContain('  - kind: code');
  });
});

describe('continuation meta-budget + request markers', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('starts at zero and increments persistently', () => {
    expect(readContinuationState(projectDir, 3).continuationsUsed).toBe(0);
    expect(recordContinuation(projectDir, 3).continuationsUsed).toBe(1);
    expect(recordContinuation(projectDir, 3).continuationsUsed).toBe(2);
    expect(readContinuationState(projectDir, 3).continuationsUsed).toBe(2);
  });

  it('clearContinuationState resets the counter', () => {
    recordContinuation(projectDir, 3);
    clearContinuationState(projectDir);
    expect(readContinuationState(projectDir, 3).continuationsUsed).toBe(0);
  });

  it('writes and reads back a continuation request', () => {
    const request: ContinuationRequest = {
      createdAt: '2026-01-01T00:00:00.000Z',
      endReason: 'finished-with-failures',
      reason: '2 task(s) remain',
      continuationsUsed: 1,
      maxContinuations: 3,
      remainingTaskIds: ['b', 'c'],
      followOnTasks: [task('b', 'pending'), task('c', 'pending')],
    };
    writeContinuationRequest(projectDir, request);
    const back = readContinuationRequest(projectDir);
    expect(back).toEqual(request);
  });

  it('readContinuationRequest returns null when absent', () => {
    expect(readContinuationRequest(projectDir)).toBeNull();
  });
});
