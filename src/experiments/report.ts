import type { HarnessEvent } from '../persistence/eventStore';
import type {
  ConfidenceInterval,
  ExperimentExecutionRecord,
  ExperimentHoldoutScorecard,
  ExperimentScorecard,
  McNemarSummary,
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

// ─── Grounded markdown scorecard report ───────────────────────────────
//
// Renders an ExperimentScorecard as markdown where every claim cites the
// scorecard field that justifies it, so a reader can trace the verdict back to
// the numbers that produced it. Pure — deterministic for a given input.

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function fmtSignedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function fmtRatio(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}×`;
}

function fmtCi(ci: ConfidenceInterval): string {
  return `[${fmtSignedPct(ci.lower)}, ${fmtSignedPct(ci.upper)}]`;
}

function fmtMcnemar(m: McNemarSummary): string {
  const stat = m.statisticWithContinuityCorrection === null
    ? 'n/a (no discordant pairs)'
    : m.statisticWithContinuityCorrection.toFixed(3);
  const verdict = m.significantAt95 ? 'significant at 95%' : 'not significant at 95%';
  return `χ²(cc)=${stat}, ${verdict} ` +
    `(baseline-only ${m.baselineOnlyPasses}, candidate-only ${m.candidateOnlyPasses})`;
}

function renderHoldoutSection(h: ExperimentHoldoutScorecard): string[] {
  return [
    '## Holdout confirmation',
    '',
    `- Held-out paired tasks: ${h.pairedTasks} (${h.taskIds.length} task ids)`,
    `- Net candidate wins: ${fmtSigned(h.paired.netCandidateWins)} ` +
      `(candidate-only ${h.paired.candidateOnlyPass}, baseline-only ${h.paired.baselineOnlyPass})`,
    `- Pass-rate delta: ${fmtSignedPct(h.passRateDelta)} ± ${fmtPct(h.passRateDeltaStdErr)} (SE), ` +
      `95% CI ${fmtCi(h.passRateDeltaCi95)}`,
    `- McNemar: ${fmtMcnemar(h.mcnemar)}`,
  ];
}

/**
 * Render a grounded markdown narrative for an experiment scorecard. Each
 * section maps directly to scorecard fields; the decision section reproduces
 * the engine's own `decision.reasons` verbatim rather than re-deriving them.
 */
export function renderScorecardReport(scorecard: ExperimentScorecard): string {
  const lines: string[] = [];
  const statusLabel = scorecard.decision.status.toUpperCase();

  lines.push(`# Experiment report: ${statusLabel}`);
  lines.push('');
  lines.push(`Candidate \`${scorecard.candidateVariantId}\` vs baseline \`${scorecard.baselineVariantId}\` ` +
    `over ${scorecard.pairedTasks} paired task(s).`);
  lines.push('');

  lines.push('## Decision');
  lines.push('');
  lines.push(`- Verdict: **${statusLabel}**`);
  lines.push(`- Automatic promotion allowed: ${scorecard.decision.automaticPromotionAllowed ? 'yes' : 'no'}`);
  if (scorecard.decision.reasons.length > 0) {
    lines.push('- Reasons:');
    for (const reason of scorecard.decision.reasons) lines.push(`  - ${reason}`);
  } else {
    lines.push('- Reasons: (none recorded)');
  }
  lines.push('');

  lines.push('## Pass rates');
  lines.push('');
  lines.push(`- Baseline pass rate: ${fmtPct(scorecard.baselinePassRate)}`);
  lines.push(`- Candidate pass rate: ${fmtPct(scorecard.candidatePassRate)}`);
  lines.push(`- Delta: ${fmtSignedPct(scorecard.passRateDelta)} ± ${fmtPct(scorecard.passRateDeltaStdErr)} (SE), ` +
    `95% CI ${fmtCi(scorecard.passRateDeltaCi95)}`);
  lines.push(`- Paired outcomes: net ${fmtSigned(scorecard.paired.netCandidateWins)} ` +
    `(both-pass ${scorecard.paired.bothPass}, both-fail ${scorecard.paired.bothFail}, ` +
    `candidate-only ${scorecard.paired.candidateOnlyPass}, baseline-only ${scorecard.paired.baselineOnlyPass})`);
  lines.push('');

  lines.push('## Significance');
  lines.push('');
  lines.push(`- ${fmtMcnemar(scorecard.mcnemar)}`);
  lines.push('');

  lines.push('## Cost');
  lines.push('');
  lines.push(`- Average duration ratio (candidate ÷ baseline): ${fmtRatio(scorecard.averageDurationRatio)}`);
  lines.push(`- Average tool-call ratio (candidate ÷ baseline): ${fmtRatio(scorecard.averageToolCallRatio)}`);
  lines.push('');

  const failureEntries = Object.entries(scorecard.failureCategoryDeltas)
    .filter(([, delta]) => typeof delta === 'number' && delta !== 0);
  lines.push('## Failure-category deltas');
  lines.push('');
  if (failureEntries.length === 0) {
    lines.push('- No net change in any failure category.');
  } else {
    for (const [category, delta] of failureEntries) {
      lines.push(`- ${category}: ${fmtSigned(delta as number)} (positive = candidate had more)`);
    }
  }
  lines.push('');

  if (scorecard.holdout) {
    lines.push(...renderHoldoutSection(scorecard.holdout));
    lines.push('');
  }

  const decisivePairs = scorecard.taskDiffs.filter(
    (d) => d.outcome === 'candidate_only_pass' || d.outcome === 'baseline_only_pass',
  );
  lines.push('## Decisive tasks');
  lines.push('');
  if (decisivePairs.length === 0) {
    lines.push('- No discordant task pairs (no task flipped between baseline and candidate).');
  } else {
    for (const diff of decisivePairs) {
      const winner = diff.outcome === 'candidate_only_pass' ? 'candidate won' : 'baseline won';
      const cat = diff.outcome === 'candidate_only_pass'
        ? diff.baselineFailureCategory
        : diff.candidateFailureCategory;
      const catNote = cat ? ` (loser failure: ${cat})` : '';
      lines.push(`- \`${diff.taskId}\`: ${winner}${catNote}`);
    }
  }

  return lines.join('\n') + '\n';
}