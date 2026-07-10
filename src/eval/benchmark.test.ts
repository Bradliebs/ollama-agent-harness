import { selectTasks, runBenchmarkTask, summarizeByTier } from './benchmark';
import type { BenchmarkTask, BenchmarkRun } from './benchmark';

// ─── scoreTask (internal via runBenchmarkTask with stubbed fetch) ────

describe('selectTasks', () => {
  const tasks: BenchmarkTask[] = [
    { id: 'canned.a', tier: 'canned', description: 'A', input: 'a' },
    { id: 'stress.b', tier: 'stress', description: 'B', input: 'b' },
    { id: 'adversarial.c', tier: 'adversarial', description: 'C', input: 'c' },
    { id: 'regression.d', tier: 'regression', description: 'D', input: 'd' },
  ];

  it('returns all tasks when no filter is set', () => {
    expect(selectTasks({}, tasks)).toHaveLength(4);
  });

  it('filters by tier', () => {
    const result = selectTasks({ tiers: ['canned', 'stress'] }, tasks);
    expect(result.map((t) => t.id)).toEqual(['canned.a', 'stress.b']);
  });

  it('filters by specific IDs (overrides tiers)', () => {
    const result = selectTasks({ filterIds: ['adversarial.c'], tiers: ['canned'] }, tasks);
    expect(result.map((t) => t.id)).toEqual(['adversarial.c']);
  });
});

describe('runBenchmarkTask', () => {
  const makeFetch = (text: string, toolCalls: string[] = []): typeof fetch => {
    return () => Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let done = false;
          const lines = [
            ...toolCalls.map((name) => `data: ${JSON.stringify({ type: 'tool_call', call: { name } })}\n`),
            `data: ${JSON.stringify({ type: 'text', content: text })}\n`,
            `data: ${JSON.stringify({ type: 'done' })}\n`,
          ];
          let idx = 0;
          return {
            read: () => {
              if (done) return Promise.resolve({ value: undefined, done: true });
              if (idx >= lines.length) { done = true; return Promise.resolve({ value: undefined, done: true }); }
              const encoder = new TextEncoder();
              return Promise.resolve({ value: encoder.encode(lines[idx++]), done: false });
            },
          };
        },
      },
    } as unknown as Response);
  };

  it('passes when expectIncludes is satisfied', async () => {
    const task: BenchmarkTask = { id: 'test.1', tier: 'canned', description: 'inc', input: 'x', expectIncludes: ['ready'] };
    const result = await runBenchmarkTask(task, { fetchImpl: makeFetch('I am ready now') });
    expect(result.status).toBe('pass');
  });

  it('fails when expectIncludes substring is missing', async () => {
    const task: BenchmarkTask = { id: 'test.2', tier: 'canned', description: 'inc', input: 'x', expectIncludes: ['confirmed'] };
    const result = await runBenchmarkTask(task, { fetchImpl: makeFetch('I am ready now') });
    expect(result.status).toBe('fail');
    expect(result.failureCategory).toBe('WRONG_ANSWER');
  });

  it('fails when expectMissing substring is present', async () => {
    const task: BenchmarkTask = { id: 'test.3', tier: 'canned', description: 'miss', input: 'x', expectMissing: ['forbidden'] };
    const result = await runBenchmarkTask(task, { fetchImpl: makeFetch('here is the forbidden word') });
    expect(result.status).toBe('fail');
  });

  it('fails when requireTools not called', async () => {
    const task: BenchmarkTask = { id: 'test.4', tier: 'stress', description: 'tool', input: 'x', requireTools: ['bash'] };
    const result = await runBenchmarkTask(task, { fetchImpl: makeFetch('done', []) });
    expect(result.status).toBe('fail');
    expect(result.failureCategory).toBe('DID_NOT_RUN_TOOLS');
  });

  it('passes when requireTools is satisfied', async () => {
    const task: BenchmarkTask = { id: 'test.5', tier: 'stress', description: 'tool', input: 'x', requireTools: ['bash'] };
    const result = await runBenchmarkTask(task, { fetchImpl: makeFetch('done', ['bash']) });
    expect(result.status).toBe('pass');
  });

  it('fails when forbiddenTools was invoked', async () => {
    const task: BenchmarkTask = { id: 'test.6', tier: 'adversarial', description: 'fbtool', input: 'x', forbiddenTools: ['file_write'] };
    const result = await runBenchmarkTask(task, { fetchImpl: makeFetch('done', ['file_write']) });
    expect(result.status).toBe('fail');
  });

  it('uses customScorer when provided', async () => {
    const task: BenchmarkTask = {
      id: 'test.7', tier: 'canned', description: 'custom', input: 'x',
      customScorer: (text) => text.includes('42') ? { pass: true, reason: 'found' } : { pass: false, reason: 'missing 42' },
    };
    const passing = await runBenchmarkTask(task, { fetchImpl: makeFetch('the answer is 42') });
    expect(passing.status).toBe('pass');
    const failing = await runBenchmarkTask(task, { fetchImpl: makeFetch('no answer here') });
    expect(failing.status).toBe('fail');
  });

  it('returns error when fetch throws', async () => {
    const task: BenchmarkTask = { id: 'test.8', tier: 'canned', description: 'err', input: 'x' };
    const throwingFetch = () => Promise.reject(new Error('network down'));
    const result = await runBenchmarkTask(task, { fetchImpl: throwingFetch as unknown as typeof fetch });
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('ERROR');
  });
});

describe('summarizeByTier', () => {
  it('groups results by tier and computes pass rate', () => {
    const run: BenchmarkRun = {
      id: 'x', startedAt: '', finishedAt: '', model: '', baseUrl: '',
      tiers: ['canned', 'adversarial'], total: 4, passed: 3, failed: 1, errored: 0, passRate: 0.75,
      results: [
        { taskId: 'a', tier: 'canned', description: '', status: 'pass', reason: '', responsePreview: '', toolCalls: [], durationMs: 0, tags: [] },
        { taskId: 'b', tier: 'canned', description: '', status: 'pass', reason: '', responsePreview: '', toolCalls: [], durationMs: 0, tags: [] },
        { taskId: 'c', tier: 'adversarial', description: '', status: 'pass', reason: '', responsePreview: '', toolCalls: [], durationMs: 0, tags: [] },
        { taskId: 'd', tier: 'adversarial', description: '', status: 'fail', reason: '', responsePreview: '', toolCalls: [], durationMs: 0, tags: [] },
      ],
    };
    const summary = summarizeByTier(run);
    const canned = summary.find((s) => s.tier === 'canned');
    const adv = summary.find((s) => s.tier === 'adversarial');
    expect(canned?.passed).toBe(2);
    expect(canned?.passRate).toBe('100%');
    expect(adv?.passed).toBe(1);
    expect(adv?.passRate).toBe('50%');
  });
});
