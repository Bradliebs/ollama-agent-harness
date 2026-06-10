import type { HarnessEvent } from '../persistence/eventStore';
import type {
  ConfidenceInterval,
  ExperimentExecutionRecord,
  ExperimentScorecard,
  PairedTaskDiff,
  ResolvedExperimentPlan,
} from './types';

export interface ExperimentEventSummary {
  eventId: string;
  timestamp: string;
  type: string;
  experimentId?: string;
  runId?: string;
  hypothesis?: string;
  selectedTaskCount?: number;
  decisionStatus?: string;
  promotionStatus?: string;
  baselineViolations?: number;
  candidateViolations?: number;
}

export interface ExperimentHistorySummary {
  totalEvents: number;
  completedRuns: number;
  dryRuns: number;
  confirmed: number;
  regressed: number;
  inconclusive: number;
  latestEventAt?: string;
}

type ExperimentEventData = Partial<ExperimentExecutionRecord & ResolvedExperimentPlan>;

export function summarizeExperimentEvent(event: HarnessEvent): ExperimentEventSummary {
  const data = event.data as ExperimentEventData;
  const evaluatorTaskCount = data.evaluator?.taskIds?.length;
  return {
    eventId: event.event_id,
    timestamp: event.timestamp,
    type: event.type,
    experimentId: data.manifest?.id ?? event.subject_id,
    runId: data.id,
    hypothesis: data.manifest?.hypothesis,
    selectedTaskCount: data.selectedTaskCount ?? evaluatorTaskCount,
    decisionStatus: data.scorecard?.decision.status,
    promotionStatus: data.promotionEvidence?.status,
    baselineViolations: data.safety?.baselineViolations,
    candidateViolations: data.safety?.candidateViolations,
  };
}

export function summarizeExperimentEvents(events: HarnessEvent[]): ExperimentEventSummary[] {
  return events.map(summarizeExperimentEvent);
}

export function summarizeExperimentHistory(events: HarnessEvent[]): ExperimentHistorySummary {
  const summaries = summarizeExperimentEvents(events);
  return {
    totalEvents: summaries.length,
    completedRuns: summaries.filter((event) => event.type === 'experiment_completed').length,
    dryRuns: summaries.filter((event) => event.type === 'experiment_dry_run').length,
    confirmed: summaries.filter((event) => event.promotionStatus === 'experiment_confirmed').length,
    regressed: summaries.filter((event) => event.promotionStatus === 'experiment_regressed').length,
    inconclusive: summaries.filter((event) => event.promotionStatus === 'experiment_inconclusive').length,
    latestEventAt: summaries.map((event) => event.timestamp).sort().at(-1),
  };
}

/** Per-task pairing outcome, flagged when the candidate and baseline diverged. */
export interface ExperimentTaskDetail {
  taskId: string;
  outcome: PairedTaskDiff['outcome'];
  baselineStatus: PairedTaskDiff['baselineStatus'];
  candidateStatus: PairedTaskDiff['candidateStatus'];
  baselineFailureCategory?: PairedTaskDiff['baselineFailureCategory'];
  candidateFailureCategory?: PairedTaskDiff['candidateFailureCategory'];
  /** True when the two arms differ on pass/fail or on failure category. */
  changed: boolean;
}

/**
 * Task-level detail for a single completed experiment run. This resolves the
 * gap where the compact history summary (and the `experiment_completed` event
 * payload) drops `scorecard.taskDiffs`, so `--show` had no way to surface which
 * tasks actually moved without re-querying the wrong record.
 */
export interface ExperimentEventDetail {
  eventId: string;
  timestamp: string;
  experimentId?: string;
  runId?: string;
  decisionStatus?: string;
  promotionStatus?: string;
  pairedTasks?: number;
  paired?: ExperimentScorecard['paired'];
  passRateDelta?: number;
  passRateDeltaCi95?: ConfidenceInterval;
  significantAt95?: boolean;
  holdout?: {
    pairedTasks: number;
    netCandidateWins: number;
    significantAt95: boolean;
  };
  changedTaskCount: number;
  taskDiffs: ExperimentTaskDetail[];
}

function taskChanged(diff: PairedTaskDiff): boolean {
  return diff.outcome === 'candidate_only_pass'
    || diff.outcome === 'baseline_only_pass'
    || diff.baselineFailureCategory !== diff.candidateFailureCategory;
}

export function detailExperimentEvent(event: HarnessEvent): ExperimentEventDetail | undefined {
  if (event.type !== 'experiment_completed') return undefined;
  const data = event.data as ExperimentEventData;
  const scorecard = data.scorecard;
  if (!scorecard) return undefined;
  const taskDiffs: ExperimentTaskDetail[] = (scorecard.taskDiffs ?? []).map((diff) => ({
    taskId: diff.taskId,
    outcome: diff.outcome,
    baselineStatus: diff.baselineStatus,
    candidateStatus: diff.candidateStatus,
    baselineFailureCategory: diff.baselineFailureCategory,
    candidateFailureCategory: diff.candidateFailureCategory,
    changed: taskChanged(diff),
  }));
  return {
    eventId: event.event_id,
    timestamp: event.timestamp,
    experimentId: data.manifest?.id ?? event.subject_id,
    runId: data.id,
    decisionStatus: scorecard.decision?.status,
    promotionStatus: data.promotionEvidence?.status,
    pairedTasks: scorecard.pairedTasks,
    paired: scorecard.paired,
    passRateDelta: scorecard.passRateDelta,
    passRateDeltaCi95: scorecard.passRateDeltaCi95,
    significantAt95: scorecard.mcnemar?.significantAt95,
    holdout: scorecard.holdout
      ? {
          pairedTasks: scorecard.holdout.pairedTasks,
          netCandidateWins: scorecard.holdout.paired.netCandidateWins,
          significantAt95: scorecard.holdout.mcnemar.significantAt95,
        }
      : undefined,
    changedTaskCount: taskDiffs.filter((diff) => diff.changed).length,
    taskDiffs,
  };
}

/** Detail views for every completed run in the event list (dry runs skipped). */
export function detailExperimentEvents(events: HarnessEvent[]): ExperimentEventDetail[] {
  return events
    .map(detailExperimentEvent)
    .filter((detail): detail is ExperimentEventDetail => detail !== undefined);
}