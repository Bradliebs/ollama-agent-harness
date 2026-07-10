import type { BenchmarkRun, BenchmarkTier, FailureCategory } from '../eval/benchmark';

export type ExperimentMutationScope =
  | 'model'
  | 'prompt'
  | 'skill'
  | 'tool_config'
  | 'routing_config'
  | 'retrieval_config'
  | 'none';

export interface ExperimentVariant {
  id: string;
  label: string;
  model?: string;
  enabledTools?: string[];
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface ExperimentEvaluationSpec {
  datasetId: string;
  scorerVersion: string;
  taskIds?: string[];
  tiers?: BenchmarkTier[];
  perTaskTimeoutMs?: number;
  /**
   * Number of stochastic replicates to run per task (default 1). When > 1,
   * each task is run this many times and aggregated into a single majority-vote
   * verdict (the k/N pass count is recorded). This keeps one verdict per task —
   * the McNemar test sees the same number of cells regardless of replicate
   * count, so this is NOT pseudoreplication; it reduces per-task sampling noise
   * so borderline tasks stop flipping the keep/discard decision on a coin toss.
   * Requires the daemon to sample at temperature > 0, otherwise every replicate
   * is identical and the aggregation is a no-op. Note that a run with R
   * replicates spends roughly R× the tool/duration budget.
   */
  replicates?: number;
  /**
   * Optional held-out split. Tasks carved out here are still evaluated, but
   * the scorer reports a separate holdout sub-scorecard and (when the
   * guardrail `minHoldoutNetWins` is set) a keep decision must also be
   * confirmed on these tasks. Use this to guard against a candidate that was
   * iterated against the visible task set. Provide EITHER an explicit task-id
   * list OR a deterministic fraction (hash-partitioned, stable across runs).
   */
  holdout?: ExperimentHoldoutSpec;
}

export interface ExperimentHoldoutSpec {
  /** Explicit task ids to hold out. Must be a subset of the selected tasks. */
  taskIds?: string[];
  /** Fraction (0,1) of selected tasks to hold out via a stable hash partition. */
  fraction?: number;
}

export interface ExperimentBudgetPolicy {
  maxTasks?: number;
  maxDurationMs?: number;
  maxCostUnits?: number;
  maxToolCalls?: number;
}

export interface ExperimentGuardrails {
  minPairedTasksForKeep?: number;
  minCandidateNetWins?: number;
  maxLatencyRegressionRatio?: number;
  maxToolCallRegressionRatio?: number;
  rejectOnFailureCategoryIncrease?: FailureCategory[];
  requireNoSafetyRegressions?: boolean;
  /**
   * When true, a keep decision additionally requires the paired McNemar test
   * to be significant at 95%. Guards against keeping wins that sit inside the
   * noise floor. Opt-in (default off) to preserve existing behaviour.
   */
  requireSignificance?: boolean;
  /**
   * When set (and a holdout split is configured), a keep decision additionally
   * requires the holdout subset to show at least this many net candidate wins.
   * Confirms the improvement generalises to tasks not used to tune the
   * candidate. Opt-in (default off).
   */
  minHoldoutNetWins?: number;
}

export interface ExperimentManifest {
  id: string;
  hypothesis: string;
  expectedMechanism: string;
  allowedMutationScopes: ExperimentMutationScope[];
  rollbackTarget: string;
  baseline: ExperimentVariant;
  candidate: ExperimentVariant;
  evaluation: ExperimentEvaluationSpec;
  budget?: ExperimentBudgetPolicy;
  guardrails?: ExperimentGuardrails;
  createdAt?: string;
  owner?: string;
  notes?: string;
}

export interface EvaluatorIdentity {
  datasetId: string;
  scorerVersion: string;
  taskIds: string[];
  tiers: BenchmarkTier[];
  perTaskTimeoutMs?: number;
}

export type ExperimentDecisionStatus = 'keep' | 'discard' | 'inconclusive';

export interface ExperimentDecision {
  status: ExperimentDecisionStatus;
  reasons: string[];
  automaticPromotionAllowed: boolean;
}

export interface SafetyGateCounts {
  baselineViolations: number;
  candidateViolations: number;
}

export type ExperimentPromotionEvidenceStatus = 'experiment_confirmed' | 'experiment_inconclusive' | 'experiment_regressed';

export interface ExperimentSafetyEvidence extends SafetyGateCounts {
  baselineViolationRules: string[];
  candidateViolationRules: string[];
}

export interface ExperimentPromotionEvidence {
  status: ExperimentPromotionEvidenceStatus;
  candidateVariantId: string;
  baselineVariantId: string;
  automaticPromotionAllowed: boolean;
  reasons: string[];
  passRateDelta: number;
  netCandidateWins: number;
}

export interface PairedTaskDiff {
  taskId: string;
  baselineStatus: 'pass' | 'fail' | 'error';
  candidateStatus: 'pass' | 'fail' | 'error';
  outcome: 'both_pass' | 'both_fail' | 'candidate_only_pass' | 'baseline_only_pass';
  baselineFailureCategory?: FailureCategory;
  candidateFailureCategory?: FailureCategory;
}

export interface McNemarSummary {
  baselineOnlyPasses: number;
  candidateOnlyPasses: number;
  statisticWithContinuityCorrection: number | null;
  significantAt95: boolean;
}

/** Two-sided 95% confidence interval for a paired pass-rate delta. */
export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

/**
 * Paired scorecard for a held-out subset of tasks. Lighter than the full
 * scorecard: it only carries the paired confirmation signal (net wins,
 * significance, noise floor), since latency / tool-call / failure-category
 * guardrails are global properties evaluated on the full set.
 */
export interface ExperimentHoldoutScorecard {
  taskIds: string[];
  pairedTasks: number;
  paired: {
    bothPass: number;
    bothFail: number;
    candidateOnlyPass: number;
    baselineOnlyPass: number;
    netCandidateWins: number;
  };
  /** Paired marginal pass-rate delta (candidateOnlyPass - baselineOnlyPass) / pairedTasks. */
  passRateDelta: number;
  /** Standard error of the paired delta (McNemar paired-proportion formula). */
  passRateDeltaStdErr: number;
  passRateDeltaCi95: ConfidenceInterval;
  mcnemar: McNemarSummary;
}

export interface ExperimentScorecard {
  baselineVariantId: string;
  candidateVariantId: string;
  pairedTasks: number;
  baselinePassRate: number;
  candidatePassRate: number;
  passRateDelta: number;
  paired: {
    bothPass: number;
    bothFail: number;
    candidateOnlyPass: number;
    baselineOnlyPass: number;
    netCandidateWins: number;
  };
  failureCategoryDeltas: Partial<Record<FailureCategory, number>>;
  averageDurationRatio: number | null;
  averageToolCallRatio: number | null;
  mcnemar: McNemarSummary;
  /** Standard error of the paired pass-rate delta (noise floor). */
  passRateDeltaStdErr: number;
  /** Two-sided 95% confidence interval for the paired pass-rate delta. */
  passRateDeltaCi95: ConfidenceInterval;
  /** Present only when evaluation.holdout is configured. */
  holdout?: ExperimentHoldoutScorecard;
  taskDiffs: PairedTaskDiff[];
  decision: ExperimentDecision;
}

export interface ResolvedExperimentPlan {
  manifest: ExperimentManifest;
  evaluator: EvaluatorIdentity;
  selectedTaskCount: number;
  selectedTaskIds: string[];
  /** Subset of selectedTaskIds held out for confirmation. Empty when no holdout is configured. */
  holdoutTaskIds?: string[];
  dryRun: boolean;
}

export interface ExperimentExecutionRecord {
  id: string;
  manifest: ExperimentManifest;
  evaluator: EvaluatorIdentity;
  baselineRun?: BenchmarkRun;
  candidateRun?: BenchmarkRun;
  safety?: ExperimentSafetyEvidence;
  scorecard?: ExperimentScorecard;
  promotionEvidence?: ExperimentPromotionEvidence;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
}