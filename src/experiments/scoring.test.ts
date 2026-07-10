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

  it('reports the paired delta standard error and confidence interval', () => {
    // Numeric trace: n=6, b=1, c=3, delta=(3-1)/6=0.3333.
    // variance = (b+c - (c-b)^2/n)/n^2 = (4 - 4/6)/36 = 3.3333/36 = 0.092593.
    // SE = sqrt(0.092593) = 0.30429.
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

    expect(scorecard.passRateDeltaStdErr).toBeCloseTo(0.30429, 4);
    expect(scorecard.passRateDeltaCi95.lower).toBeCloseTo(0.3333 - 1.96 * 0.30429, 3);
    expect(scorecard.passRateDeltaCi95.upper).toBeCloseTo(0.3333 + 1.96 * 0.30429, 3);
  });

  it('scores a held-out subset as a separate confirmation scorecard', () => {
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

    // Holdout = one candidate win + one baseline win => net 0 on the held-out split.
    const scorecard = scorePairedExperiment({
      baselineVariantId: 'baseline',
      candidateVariantId: 'candidate',
      baselineRun: baseline,
      candidateRun: candidate,
      guardrails: { minPairedTasksForKeep: 6, minCandidateNetWins: 2, rejectOnFailureCategoryIncrease: [] },
      holdoutTaskIds: ['candidate-win-1', 'baseline-win'],
    });

    expect(scorecard.holdout).toBeDefined();
    expect(scorecard.holdout?.pairedTasks).toBe(2);
    expect(scorecard.holdout?.paired.candidateOnlyPass).toBe(1);
    expect(scorecard.holdout?.paired.baselineOnlyPass).toBe(1);
    expect(scorecard.holdout?.paired.netCandidateWins).toBe(0);
    // Full-set decision is unaffected when no holdout guardrail is set.
    expect(scorecard.decision.status).toBe('keep');
  });

  it('blocks a keep when the holdout split does not confirm', () => {
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
      guardrails: { minPairedTasksForKeep: 6, minCandidateNetWins: 2, minHoldoutNetWins: 1, rejectOnFailureCategoryIncrease: [] },
      holdoutTaskIds: ['candidate-win-1', 'baseline-win'],
    });

    // Full set net +2 would keep, but holdout net 0 < required 1.
    expect(scorecard.paired.netCandidateWins).toBe(2);
    expect(scorecard.decision.status).toBe('inconclusive');
    expect(scorecard.decision.reasons[0]).toContain('Holdout split did not confirm');
  });

  it('downgrades a keep to inconclusive when requireSignificance is set and the win is in the noise floor', () => {
    // Numeric trace: b=1, c=3 => McNemar = (|3-1|-1)^2/(3+1) = 1/4 = 0.25 < 3.841, not significant.
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
      guardrails: { minPairedTasksForKeep: 6, minCandidateNetWins: 2, requireSignificance: true, rejectOnFailureCategoryIncrease: [] },
    });

    expect(scorecard.mcnemar.significantAt95).toBe(false);
    expect(scorecard.decision.status).toBe('inconclusive');
    expect(scorecard.decision.reasons[0]).toContain('not significant at 95%');
  });

  it('keeps a significant candidate even when requireSignificance is set', () => {
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
      guardrails: { minPairedTasksForKeep: 20, minCandidateNetWins: 1, requireSignificance: true, rejectOnFailureCategoryIncrease: [] },
    });

    expect(scorecard.mcnemar.significantAt95).toBe(true);
    expect(scorecard.decision.status).toBe('keep');
    expect(scorecard.decision.automaticPromotionAllowed).toBe(true);
  });
});