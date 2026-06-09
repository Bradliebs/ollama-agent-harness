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
  taskDiffs: PairedTaskDiff[];
  decision: ExperimentDecision;
}

export interface ResolvedExperimentPlan {
  manifest: ExperimentManifest;
  evaluator: EvaluatorIdentity;
  selectedTaskCount: number;
  selectedTaskIds: string[];
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