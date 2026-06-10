import type { HarnessEvent } from '../persistence/eventStore';
import { detailExperimentEvents, summarizeExperimentEvent, summarizeExperimentHistory } from './report';

function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    event_id: 'evt-1',
    category: 'experiment',
    type: 'experiment_completed',
    timestamp: '2026-06-09T00:00:00.000Z',
    actor: 'system',
    subject_id: 'exp-1',
    data: {
      id: 'run-1',
      manifest: { id: 'exp-1', hypothesis: 'Candidate improves greetings.' },
      evaluator: { taskIds: ['task-1', 'task-2'] },
      scorecard: { decision: { status: 'keep' } },
      promotionEvidence: { status: 'experiment_confirmed' },
      safety: { baselineViolations: 0, candidateViolations: 0 },
    },
    ...overrides,
  };
}

describe('experiment report summaries', () => {
  it('summarizes completed experiment evidence for history output', () => {
    expect(summarizeExperimentEvent(event())).toEqual({
      eventId: 'evt-1',
      timestamp: '2026-06-09T00:00:00.000Z',
      type: 'experiment_completed',
      experimentId: 'exp-1',
      runId: 'run-1',
      hypothesis: 'Candidate improves greetings.',
      selectedTaskCount: 2,
      decisionStatus: 'keep',
      promotionStatus: 'experiment_confirmed',
      baselineViolations: 0,
      candidateViolations: 0,
    });
  });

  it('summarizes dry-run plans without requiring scorecard evidence', () => {
    const summary = summarizeExperimentEvent(event({
      type: 'experiment_dry_run',
      data: {
        manifest: { id: 'exp-2', hypothesis: 'Dry run only.' },
        selectedTaskCount: 3,
      },
      subject_id: 'exp-2',
    }));

    expect(summary).toMatchObject({
      type: 'experiment_dry_run',
      experimentId: 'exp-2',
      selectedTaskCount: 3,
    });
    expect(summary.decisionStatus).toBeUndefined();
  });

  it('summarizes aggregate experiment history counts', () => {
    expect(summarizeExperimentHistory([
      event(),
      event({ event_id: 'evt-2', timestamp: '2026-06-09T00:01:00.000Z', data: { promotionEvidence: { status: 'experiment_regressed' } } }),
      event({ event_id: 'evt-3', type: 'experiment_dry_run', timestamp: '2026-06-09T00:02:00.000Z', data: {} }),
    ])).toEqual({
      totalEvents: 3,
      completedRuns: 2,
      dryRuns: 1,
      confirmed: 1,
      regressed: 1,
      inconclusive: 0,
      latestEventAt: '2026-06-09T00:02:00.000Z',
    });
  });
});
describe('experiment task-level detail (--show)', () => {
  function completedWithDiffs(): HarnessEvent {
    return event({
      data: {
        id: 'run-9',
        manifest: { id: 'exp-1', hypothesis: 'h' },
        promotionEvidence: { status: 'experiment_confirmed' },
        scorecard: {
          decision: { status: 'keep' },
          pairedTasks: 3,
          passRateDelta: 0.3333333333333333,
          passRateDeltaCi95: { lower: 0.1, upper: 0.56 },
          paired: { bothPass: 1, bothFail: 1, candidateOnlyPass: 1, baselineOnlyPass: 0, netCandidateWins: 1 },
          mcnemar: { baselineOnlyPasses: 0, candidateOnlyPasses: 1, statisticWithContinuityCorrection: null, significantAt95: false },
          taskDiffs: [
            { taskId: 'a', outcome: 'both_pass', baselineStatus: 'pass', candidateStatus: 'pass' },
            { taskId: 'b', outcome: 'both_fail', baselineStatus: 'fail', candidateStatus: 'fail', baselineFailureCategory: 'WRONG_ANSWER', candidateFailureCategory: 'WRONG_ANSWER' },
            { taskId: 'c', outcome: 'candidate_only_pass', baselineStatus: 'fail', candidateStatus: 'pass', baselineFailureCategory: 'WRONG_ANSWER' },
          ],
        },
      } as HarnessEvent['data'],
    });
  }

  it('surfaces per-task diffs and flags which tasks moved', () => {
    const [detail] = detailExperimentEvents([completedWithDiffs()]);
    expect(detail.runId).toBe('run-9');
    expect(detail.decisionStatus).toBe('keep');
    expect(detail.pairedTasks).toBe(3);
    expect(detail.significantAt95).toBe(false);
    expect(detail.changedTaskCount).toBe(1);
    expect(detail.taskDiffs.map((diff) => [diff.taskId, diff.changed])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
  });

  it('skips dry-run and scorecard-less events', () => {
    expect(detailExperimentEvents([
      event({ type: 'experiment_dry_run', data: { manifest: { id: 'exp-2' }, selectedTaskCount: 3 } }),
    ])).toEqual([]);
  });
});