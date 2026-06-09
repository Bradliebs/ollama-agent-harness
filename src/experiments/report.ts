import type { HarnessEvent } from '../persistence/eventStore';
import type { ExperimentExecutionRecord, ResolvedExperimentPlan } from './types';

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