import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { persistBenchmarkRun, type BenchmarkRun } from '../eval/benchmark';
import { aggregatePanels, writeMetricsJson, type BenchmarkRunMetrics, type BenchmarkTaskMetrics } from './metrics';
import { runPanel, type Signal } from './panel';

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'run-test-001',
    startedAt: '2025-01-01T00:00:00.000Z',
    finishedAt: '2025-01-01T00:00:05.000Z',
    model: 'test-model',
    baseUrl: 'http://localhost:0',
    tiers: ['canned'],
    total: 2,
    passed: 1,
    failed: 1,
    errored: 0,
    passRate: 0.5,
    results: [
      { taskId: 'a', tier: 'canned', description: 'a', status: 'pass', reason: 'ok', responsePreview: '', toolCalls: ['fs'], durationMs: 100, tags: [] },
      { taskId: 'b', tier: 'canned', description: 'b', status: 'fail', reason: 'no', responsePreview: '', toolCalls: [], durationMs: 200, tags: [] },
    ],
    ...overrides,
  };
}

describe('metrics envelope', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'metrics-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('persistBenchmarkRun writes both the legacy run file and metrics.json', async () => {
    const run = makeRun();
    await persistBenchmarkRun(tmp, run);
    const runFile = path.join(tmp, '.harness', 'benchmarks', `${run.id}.json`);
    const metricsFile = path.join(tmp, '.harness', 'benchmarks', 'metrics.json');
    const [runRaw, metricsRaw] = await Promise.all([
      fs.readFile(runFile, 'utf-8'),
      fs.readFile(metricsFile, 'utf-8'),
    ]);
    const m = JSON.parse(metricsRaw) as BenchmarkRunMetrics;
    expect(JSON.parse(runRaw).id).toBe(run.id);
    expect(m.runId).toBe(run.id);
    expect(m.total).toBe(2);
    expect(m.passed).toBe(1);
    expect(m.durationMs).toBe(5000);
    expect(m.tasks).toHaveLength(2);
    expect(m.tasks[0]).toMatchObject({ taskId: 'a', status: 'pass', toolCalls: 1 });
    expect(m).not.toHaveProperty('tokensIn');
    expect(m).not.toHaveProperty('costUsd');
    expect(m).not.toHaveProperty('perSignal');
  });

  it('writeMetricsJson is idempotent for the same file path', async () => {
    const metrics: BenchmarkRunMetrics = {
      runId: 'r1', startedAt: 's', finishedAt: 'f', durationMs: 1,
      model: 'm', baseUrl: 'b', tiers: ['canned'],
      total: 1, passed: 1, failed: 0, errored: 0, passRate: 1, tasks: [],
    };
    await writeMetricsJson(tmp, metrics);
    await writeMetricsJson(tmp, { ...metrics, total: 99 });
    const raw = await fs.readFile(path.join(tmp, 'metrics.json'), 'utf-8');
    expect(JSON.parse(raw).total).toBe(99);
  });
});

describe('aggregatePanels', () => {
  it('returns empty object when no task carries a panel', () => {
    const tasks: BenchmarkTaskMetrics[] = [
      { taskId: 'a', tier: 'canned', status: 'pass', durationMs: 1, toolCalls: 0 },
    ];
    expect(aggregatePanels(tasks)).toEqual({});
  });

  it('averages per-signal and per-axis across tasks; abstain counted but not summed', () => {
    const sigA: Signal = { name: 'a', axis: 'correctness', run: () => ({ score: 80, findings: [] }) };
    const sigB: Signal = { name: 'b', axis: 'safety', run: () => ({ score: 0, findings: [], abstain: true }) };
    const panel1 = runPanel([sigA, sigB], {}, baseCtx());
    const sigA2: Signal = { name: 'a', axis: 'correctness', run: () => ({ score: 40, findings: [] }) };
    const sigB2: Signal = { name: 'b', axis: 'safety', run: () => ({ score: 90, findings: [] }) };
    const panel2 = runPanel([sigA2, sigB2], {}, baseCtx());
    const tasks: BenchmarkTaskMetrics[] = [
      { taskId: 't1', tier: 'canned', status: 'pass', durationMs: 1, toolCalls: 0, panel: panel1 },
      { taskId: 't2', tier: 'canned', status: 'pass', durationMs: 1, toolCalls: 0, panel: panel2 },
    ];
    const { perSignal, perAxis } = aggregatePanels(tasks);
    expect(perSignal?.a).toEqual({ score: 60, abstainCount: 0, runs: 2 });
    expect(perSignal?.b).toEqual({ score: 90, abstainCount: 1, runs: 1 });
    expect(perAxis?.correctness.runs).toBe(2);
    expect(perAxis?.correctness.score).toBe(60);
    expect(perAxis?.safety.runs).toBe(1);
    expect(perAxis?.safety.score).toBe(90);
  });
});

function baseCtx() {
  return {
    response: '', toolCallCount: 0, toolSuccessCount: 0,
    errored: false, refused: false, highRisk: false, dryRun: false,
  };
}
