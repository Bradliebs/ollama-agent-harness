import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { BenchmarkTask } from '../eval/benchmark';
import type { ExperimentManifest } from './types';
import { listExperimentEvents } from './persistence';
import { runExperiment } from './runner';

function makeFetch(modelBehavior: Record<string, string>, toolCallsByModel: Record<string, string[]> = {}): typeof fetch {
  return ((input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const model = body.model ?? 'unknown';
    const text = modelBehavior[model] ?? 'default';
    const lines = [
      ...((toolCallsByModel[model] ?? []).map((name) => `data: ${JSON.stringify({ type: 'tool_call', call: { name } })}\n`)),
      `data: ${JSON.stringify({ type: 'text', content: text })}\n`,
      `data: ${JSON.stringify({ type: 'done' })}\n`,
    ];
    let index = 0;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            if (index >= lines.length) return Promise.resolve({ value: undefined, done: true });
            const encoder = new TextEncoder();
            return Promise.resolve({ value: encoder.encode(lines[index++]), done: false });
          },
        }),
      },
    } as unknown as Response);
  }) as typeof fetch;
}

function manifest(): ExperimentManifest {
  return {
    id: 'exp-1',
    hypothesis: 'Candidate says hello more often.',
    expectedMechanism: 'Candidate model follows greeting tasks better.',
    allowedMutationScopes: ['model'],
    rollbackTarget: 'HEAD',
    baseline: { id: 'baseline', label: 'Baseline', model: 'baseline-model' },
    candidate: { id: 'candidate', label: 'Candidate', model: 'candidate-model' },
    evaluation: { datasetId: 'fixture', scorerVersion: 'v1', taskIds: ['greeting'] },
    guardrails: { minPairedTasksForKeep: 1, rejectOnFailureCategoryIncrease: [] },
  };
}

jest.mock('../eval/benchmarkTasks', () => ({
  BUILT_IN_TASKS: [
    { id: 'greeting', tier: 'canned', description: 'say hello', input: 'hi', expectIncludes: ['hello'] },
  ] satisfies BenchmarkTask[],
}));

describe('runExperiment', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'experiment-runner-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('dry-runs and persists the resolved plan without model calls', async () => {
    const result = await runExperiment({ projectDir: tmpDir, manifest: manifest(), dryRun: true });
    expect(result.type).toBe('dry_run');
    if (result.type === 'dry_run') expect(result.plan.selectedTaskIds).toEqual(['greeting']);
    const events = await listExperimentEvents(tmpDir, 'exp-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('experiment_dry_run');
  });

  it('runs baseline and candidate, scores the pair, and persists completion', async () => {
    const result = await runExperiment({
      projectDir: tmpDir,
      manifest: manifest(),
      fetchImpl: makeFetch({
        'baseline-model': 'no greeting here',
        'candidate-model': 'hello there',
      }),
      now: () => new Date('2026-06-09T00:00:00.000Z'),
    });

    expect(result.type).toBe('completed');
    if (result.type === 'completed') {
      expect(result.record.scorecard?.paired.candidateOnlyPass).toBe(1);
      expect(result.record.scorecard?.decision.status).toBe('keep');
    }
    const events = await listExperimentEvents(tmpDir, 'exp-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('experiment_completed');
  });

  it('rejects an otherwise passing candidate when safety evidence regresses', async () => {
    const result = await runExperiment({
      projectDir: tmpDir,
      manifest: manifest(),
      fetchImpl: makeFetch({
        'baseline-model': 'hello there',
        'candidate-model': 'hello there AKIAIOSFODNN7EXAMPLE',
      }),
      now: () => new Date('2026-06-09T00:00:00.000Z'),
    });

    expect(result.type).toBe('completed');
    if (result.type === 'completed') {
      expect(result.record.safety).toMatchObject({ baselineViolations: 0, candidateViolations: 1 });
      expect(result.record.scorecard?.decision.status).toBe('discard');
      expect(result.record.promotionEvidence?.status).toBe('experiment_regressed');
      expect(result.record.promotionEvidence?.automaticPromotionAllowed).toBe(false);
    }
  });

  it('enforces maxDurationMs after benchmark runs', async () => {
    let index = 0;
    const ticks = [
      new Date('2026-06-09T00:00:00.000Z'),
      new Date('2026-06-09T00:00:00.010Z'),
      new Date('2026-06-09T00:00:00.020Z'),
    ];
    await expect(runExperiment({
      projectDir: tmpDir,
      manifest: { ...manifest(), budget: { maxDurationMs: 5 } },
      fetchImpl: makeFetch({ 'baseline-model': 'hello', 'candidate-model': 'hello' }),
      now: () => ticks[Math.min(index++, ticks.length - 1)],
    })).rejects.toThrow(/budget.maxDurationMs/);
  });

  it('enforces maxToolCalls after paired benchmark runs', async () => {
    await expect(runExperiment({
      projectDir: tmpDir,
      manifest: { ...manifest(), budget: { maxToolCalls: 1 } },
      fetchImpl: makeFetch(
        { 'baseline-model': 'hello', 'candidate-model': 'hello' },
        { 'baseline-model': ['grep'], 'candidate-model': ['grep'] },
      ),
      now: () => new Date('2026-06-09T00:00:00.000Z'),
    })).rejects.toThrow(/budget.maxToolCalls/);
  });
});