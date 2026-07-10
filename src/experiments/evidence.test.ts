import type { BenchmarkRun, BenchmarkTask, BenchmarkTaskResult } from '../eval/benchmark';
import { buildExperimentPromotionEvidence, buildExperimentSafetyEvidence } from './evidence';
import { scorePairedExperiment } from './scoring';

function task(id: string, input = 'say hello'): BenchmarkTask {
  return { id, tier: 'canned', description: id, input };
}

function result(taskId: string, responsePreview: string, status: BenchmarkTaskResult['status'] = 'pass'): BenchmarkTaskResult {
  return {
    taskId,
    tier: 'canned',
    description: taskId,
    status,
    reason: status === 'pass' ? 'ok' : 'failed',
    responsePreview,
    toolCalls: [],
    durationMs: 100,
    tags: [],
  };
}

function run(id: string, results: BenchmarkTaskResult[]): BenchmarkRun {
  const passed = results.filter((entry) => entry.status === 'pass').length;
  return {
    id,
    startedAt: '2026-06-09T00:00:00.000Z',
    finishedAt: '2026-06-09T00:01:00.000Z',
    model: id,
    baseUrl: 'http://127.0.0.1:4300',
    tiers: ['canned'],
    total: results.length,
    passed,
    failed: results.length - passed,
    errored: 0,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };
}

describe('experiment evidence', () => {
  it('counts candidate-only safety violations from durable benchmark evidence', () => {
    const baseline = run('baseline', [result('task-1', 'hello there')]);
    const candidate = run('candidate', [result('task-1', 'hello there AKIAIOSFODNN7EXAMPLE')]);

    const evidence = buildExperimentSafetyEvidence([task('task-1')], baseline, candidate);

    expect(evidence.baselineViolations).toBe(0);
    expect(evidence.candidateViolations).toBe(1);
    expect(evidence.candidateViolationRules).toEqual(['secret.aws-key']);
  });

  it('maps a kept scorecard into promotion confirmation evidence', () => {
    const baseline = run('baseline', [result('task-1', '', 'fail')]);
    const candidate = run('candidate', [result('task-1', 'ok', 'pass')]);
    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: baseline,
      candidateRun: candidate,
      guardrails: { minPairedTasksForKeep: 1, minCandidateNetWins: 1, rejectOnFailureCategoryIncrease: [] },
    });

    const evidence = buildExperimentPromotionEvidence(scorecard);

    expect(evidence.status).toBe('experiment_confirmed');
    expect(evidence.automaticPromotionAllowed).toBe(true);
    expect(evidence.netCandidateWins).toBe(1);
  });
});