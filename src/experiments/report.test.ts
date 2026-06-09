import type { HarnessEvent } from '../persistence/eventStore';
import { summarizeExperimentEvent, summarizeExperimentHistory } from './report';

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