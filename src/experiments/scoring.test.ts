import type { BenchmarkRun, BenchmarkTaskResult, FailureCategory } from '../eval/benchmark';
import { scorePairedExperiment } from './scoring';

function result(taskId: string, status: BenchmarkTaskResult['status'], failureCategory?: FailureCategory, durationMs = 100, toolCalls: string[] = []): BenchmarkTaskResult {
  return {
    taskId,
    tier: 'canned',
    description: taskId,
    status,
    failureCategory,
    reason: status === 'pass' ? 'ok' : 'failed',
    responsePreview: '',
    toolCalls,
    durationMs,
    tags: [],
  };
}

function run(id: string, results: BenchmarkTaskResult[]): BenchmarkRun {
  const passed = results.filter((entry) => entry.status === 'pass').length;
  const failed = results.filter((entry) => entry.status === 'fail').length;
  const errored = results.filter((entry) => entry.status === 'error').length;
  return {
    id,
    startedAt: '2026-06-09T00:00:00.000Z',
    finishedAt: '2026-06-09T00:01:00.000Z',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:4300',
    tiers: ['canned'],
    total: results.length,
    passed,
    failed,
    errored,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };
}

describe('scorePairedExperiment', () => {
  it('keeps a candidate with enough paired net wins', () => {
    // Numeric trace: candidate-only passes = 3, baseline-only passes = 1, net = +2, therefore candidate improved.
    const baseline = run('baseline', [
      result('both-pass', 'pass'),
      result('candidate-win-1', 'fail'),
      result('candidate-win-2', 'fail'),
      result('candidate-win-3', 'fail'),
      result('baseline-win', 'pass'),
      result('both-fail', 'fail'),
    ]);
    const candidate = run('candidate', [
      result('both-pass', 'pass'),
      result('candidate-win-1', 'pass'),
      result('candidate-win-2', 'pass'),
      result('candidate-win-3', 'pass'),
      result('baseline-win', 'fail'),
      result('both-fail', 'fail'),
    ]);

    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: baseline,
      candidateRun: candidate,
      guardrails: { minPairedTasksForKeep: 6, minCandidateNetWins: 2, rejectOnFailureCategoryIncrease: [] },
    });

    expect(scorecard.paired.candidateOnlyPass).toBe(3);
    expect(scorecard.paired.baselineOnlyPass).toBe(1);
    expect(scorecard.paired.netCandidateWins).toBe(2);
    expect(scorecard.decision.status).toBe('keep');
    expect(scorecard.decision.automaticPromotionAllowed).toBe(true);
  });

  it('marks small evaluation wins inconclusive instead of promotable', () => {
    const baseline = run('baseline', [result('task-1', 'fail'), result('task-2', 'fail')]);
    const candidate = run('candidate', [result('task-1', 'pass'), result('task-2', 'pass')]);

    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: baseline,
      candidateRun: candidate,
      guardrails: { minPairedTasksForKeep: 20, rejectOnFailureCategoryIncrease: [] },
    });

    expect(scorecard.paired.netCandidateWins).toBe(2);
    expect(scorecard.decision.status).toBe('inconclusive');
    expect(scorecard.decision.automaticPromotionAllowed).toBe(false);
  });

  it('discards candidates that lose more paired tasks than they win', () => {
    const baseline = run('baseline', [result('task-1', 'pass'), result('task-2', 'pass'), result('task-3', 'fail')]);
    const candidate = run('candidate', [result('task-1', 'fail'), result('task-2', 'fail'), result('task-3', 'pass')]);

    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: baseline,
      candidateRun: candidate,
      guardrails: { minPairedTasksForKeep: 3, rejectOnFailureCategoryIncrease: [] },
    });

    expect(scorecard.paired.netCandidateWins).toBe(-1);
    expect(scorecard.decision.status).toBe('discard');
  });

  it('hard-rejects safety regressions', () => {
    const baseline = run('baseline', [result('task-1', 'pass')]);
    const candidate = run('candidate', [result('task-1', 'pass')]);

    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: baseline,
      candidateRun: candidate,
      safety: { baselineViolations: 0, candidateViolations: 1 },
    });

    expect(scorecard.decision.status).toBe('discard');
    expect(scorecard.decision.reasons[0]).toContain('safety violations increased');
  });

  it('hard-rejects configured failure-category regressions', () => {
    const baseline = run('baseline', [result('task-1', 'pass')]);
    const candidate = run('candidate', [result('task-1', 'fail', 'WRONG_ANSWER')]);

    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: baseline,
      candidateRun: candidate,
      guardrails: { minPairedTasksForKeep: 1, rejectOnFailureCategoryIncrease: ['WRONG_ANSWER'] },
    });

    expect(scorecard.failureCategoryDeltas.WRONG_ANSWER).toBe(1);
    expect(scorecard.decision.status).toBe('discard');
    expect(scorecard.decision.reasons[0]).toContain('WRONG_ANSWER');
  });

  it('reports McNemar significance from paired disagreements', () => {
    const baselineResults = [
      ...Array.from({ length: 4 }, (_, index) => result(`baseline-win-${index}`, 'pass')),
      ...Array.from({ length: 20 }, (_, index) => result(`candidate-win-${index}`, 'fail')),
    ];
    const candidateResults = [
      ...Array.from({ length: 4 }, (_, index) => result(`baseline-win-${index}`, 'fail')),
      ...Array.from({ length: 20 }, (_, index) => result(`candidate-win-${index}`, 'pass')),
    ];

    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: run('baseline', baselineResults),
      candidateRun: run('candidate', candidateResults),
      guardrails: { minPairedTasksForKeep: 20, minCandidateNetWins: 1, rejectOnFailureCategoryIncrease: [] },
    });

    expect(scorecard.mcnemar.baselineOnlyPasses).toBe(4);
    expect(scorecard.mcnemar.candidateOnlyPasses).toBe(20);
    expect(scorecard.mcnemar.significantAt95).toBe(true);
  });
});