import type { BenchmarkTask } from '../eval/benchmark';
import type { ExperimentManifest } from './types';
import { buildEvaluatorIdentity, validateExperimentManifest } from './manifest';

function manifest(overrides: Partial<ExperimentManifest> = {}): ExperimentManifest {
  return {
    id: 'exp-1',
    hypothesis: 'A narrower tool set reduces wrong tool calls.',
    expectedMechanism: 'The candidate removes distracting tools from the action space.',
    allowedMutationScopes: ['tool_config'],
    rollbackTarget: 'HEAD',
    baseline: { id: 'baseline', label: 'Current defaults' },
    candidate: { id: 'candidate', label: 'Read-only tools only' },
    evaluation: { datasetId: 'benchmarks:v1', scorerVersion: 'benchmark.ts:v1', taskIds: ['task-a'] },
    ...overrides,
  };
}

describe('validateExperimentManifest', () => {
  it('accepts a complete manifest', () => {
    const result = validateExperimentManifest(manifest());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('requires a hypothesis, mechanism, evaluator identity, and rollback target', () => {
    const result = validateExperimentManifest(manifest({
      hypothesis: '',
      expectedMechanism: '',
      rollbackTarget: '',
      evaluation: { datasetId: '', scorerVersion: '' },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'hypothesis is required.',
      'expectedMechanism is required.',
      'rollbackTarget is required.',
      'evaluation.datasetId is required.',
      'evaluation.scorerVersion is required.',
    ]));
  });

  it('rejects unknown mutation scopes and distinctness mistakes', () => {
    const result = validateExperimentManifest(manifest({
      allowedMutationScopes: ['none', 'prompt'],
      candidate: { id: 'baseline', label: 'Same id' },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'allowedMutationScopes cannot combine none with mutable scopes.',
      'baseline.id and candidate.id must be distinct.',
    ]));
  });

  it('rejects invalid budget values', () => {
    const result = validateExperimentManifest(manifest({
      budget: { maxTasks: 0, maxDurationMs: 0, maxCostUnits: -1, maxToolCalls: -1 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'budget.maxTasks must be positive when provided.',
      'budget.maxDurationMs must be positive when provided.',
      'budget.maxCostUnits must be positive when provided.',
      'budget.maxToolCalls cannot be negative when provided.',
    ]));
  });

  it('rejects a holdout that sets both fraction and taskIds', () => {
    const result = validateExperimentManifest(manifest({
      evaluation: { datasetId: 'benchmarks:v1', scorerVersion: 'benchmark.ts:v1', holdout: { fraction: 0.3, taskIds: ['task-a'] } },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'evaluation.holdout cannot set both fraction and taskIds.',
    ]));
  });

  it('rejects a holdout fraction outside the open interval (0,1)', () => {
    const result = validateExperimentManifest(manifest({
      evaluation: { datasetId: 'benchmarks:v1', scorerVersion: 'benchmark.ts:v1', holdout: { fraction: 1 } },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'evaluation.holdout.fraction must be between 0 and 1 (exclusive) when provided.',
    ]));
  });

  it('rejects an empty holdout that sets neither fraction nor taskIds', () => {
    const result = validateExperimentManifest(manifest({
      evaluation: { datasetId: 'benchmarks:v1', scorerVersion: 'benchmark.ts:v1', holdout: {} },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'evaluation.holdout must set either fraction or taskIds.',
    ]));
  });

  it('accepts a valid holdout fraction', () => {
    const result = validateExperimentManifest(manifest({
      evaluation: { datasetId: 'benchmarks:v1', scorerVersion: 'benchmark.ts:v1', taskIds: ['task-a'], holdout: { fraction: 0.25 } },
    }));
    expect(result).toEqual({ ok: true, errors: [] });
  });
});

describe('buildEvaluatorIdentity', () => {
  it('captures the frozen task set and scorer identity in deterministic order', () => {
    const tasks: BenchmarkTask[] = [
      { id: 'z-task', tier: 'stress', description: 'z', input: 'z' },
      { id: 'a-task', tier: 'canned', description: 'a', input: 'a' },
    ];
    const identity = buildEvaluatorIdentity(manifest({ evaluation: { datasetId: 'benchmarks:v2', scorerVersion: 'scorer:abc', perTaskTimeoutMs: 5000 } }), tasks);
    expect(identity).toEqual({
      datasetId: 'benchmarks:v2',
      scorerVersion: 'scorer:abc',
      taskIds: ['a-task', 'z-task'],
      tiers: ['canned', 'stress'],
      perTaskTimeoutMs: 5000,
    });
  });
});