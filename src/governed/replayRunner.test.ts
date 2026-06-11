import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initReplayConsumer } from './replayConsumer';
import { runReplayCandidates } from './replayRunner';
import { initReviewQueue, listReviewItems } from './reviewQueue';
import type { GovernedAnswer } from './governedAnswer';
import type { ReplayCandidate } from './replayConsumer';

function makeGoverned(answer: string): GovernedAnswer {
  return {
    answer,
    confidence: { mode: 'needs-review', reason: 'replayed' },
    critique: { findings: [], overall: 'review' },
    workingMemory: null,
    proposedBrainUpdates: [],
  };
}

describe('replayRunner', () => {
  let projectDir: string;
  let seamPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-runner-'));
    seamPath = path.join(projectDir, '.harness', 'needs-review-replay.jsonl');
    fs.mkdirSync(path.dirname(seamPath), { recursive: true });
    initReplayConsumer(projectDir);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('does nothing when the seam is empty', async () => {
    fs.rmSync(seamPath, { force: true });
    const enqueue = jest.fn();
    const runOne = jest.fn();
    const result = await runReplayCandidates({ runOne, enqueue });
    expect(result).toEqual({ consumed: 0, replayed: 0, reQueued: 0 });
    expect(runOne).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('consumes candidates, re-runs each, and re-enqueues fresh governed answers', async () => {
    fs.writeFileSync(
      seamPath,
      [
        JSON.stringify({ id: 'a', content: 'claim A', reason: 'flagged', drainedAt: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ id: 'b', content: 'claim B', reason: 'flagged', drainedAt: '2026-01-02T00:00:00.000Z' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const enqueue = jest.fn();
    const runOne = jest.fn(async (c: ReplayCandidate) => makeGoverned(`re: ${c.content}`));

    const result = await runReplayCandidates({ runOne, enqueue });

    expect(result).toEqual({ consumed: 2, replayed: 2, reQueued: 2 });
    expect(runOne).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0][0].answer).toBe('re: claim A');
    // The runner hands the original candidate to enqueue so a before/after
    // diff can be recorded against the re-investigated answer.
    expect(enqueue.mock.calls[0][1].id).toBe('a');
    // The seam is drained — a second run replays nothing.
    const second = await runReplayCandidates({ runOne, enqueue });
    expect(second).toEqual({ consumed: 0, replayed: 0, reQueued: 0 });
  });

  it('records the before/after diff on the re-queued item via the default enqueue', async () => {
    initReviewQueue(projectDir);
    fs.writeFileSync(
      seamPath,
      JSON.stringify({ id: 'orig-1', content: 'old answer', reason: 'flagged', drainedAt: '2026-01-01T00:00:00.000Z' }) + '\n',
      'utf-8',
    );

    const runOne = jest.fn(async () => makeGoverned('new answer'));
    const result = await runReplayCandidates({ runOne });
    expect(result).toEqual({ consumed: 1, replayed: 1, reQueued: 1 });

    const queued = listReviewItems().find((i) => i.replayOf === 'orig-1');
    expect(queued).toBeDefined();
    expect(queued?.priorContent).toBe('old answer');
    expect(queued?.content).toBe('new answer');
    expect(queued?.reason).toContain('replay of orig-1 (changed)');
  });

  it('counts a replay but skips re-enqueue when the run yields no governed answer', async () => {
    fs.writeFileSync(
      seamPath,
      JSON.stringify({ id: 'a', content: 'claim', reason: 'flagged', drainedAt: '2026-01-01T00:00:00.000Z' }) + '\n',
      'utf-8',
    );

    const enqueue = jest.fn();
    const runOne = jest.fn(async () => null);

    const result = await runReplayCandidates({ runOne, enqueue });
    expect(result).toEqual({ consumed: 1, replayed: 1, reQueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('logs and continues when a single replay run throws', async () => {
    fs.writeFileSync(
      seamPath,
      [
        JSON.stringify({ id: 'a', content: 'boom', reason: 'flagged', drainedAt: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ id: 'b', content: 'ok', reason: 'flagged', drainedAt: '2026-01-02T00:00:00.000Z' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const enqueue = jest.fn();
    const runOne = jest.fn(async (c: ReplayCandidate) => {
      if (c.id === 'a') throw new Error('replay failed');
      return makeGoverned(`re: ${c.content}`);
    });

    const result = await runReplayCandidates({ runOne, enqueue });
    expect(result).toEqual({ consumed: 2, replayed: 1, reQueued: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].answer).toBe('re: ok');
  });
});
