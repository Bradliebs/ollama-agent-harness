import type { BenchmarkRun, BenchmarkTaskResult, FailureCategory } from '../eval/benchmark';
import type { ExperimentGuardrails, ExperimentScorecard, PairedTaskDiff, SafetyGateCounts } from './types';

export interface PairedExperimentScoringInput {
  baselineVariantId: string;
  candidateVariantId: string;
  baselineRun: BenchmarkRun;
  candidateRun: BenchmarkRun;
  guardrails?: ExperimentGuardrails;
  safety?: SafetyGateCounts;
}

const DEFAULT_REJECT_CATEGORIES: FailureCategory[] = [
  'WRONG_ANSWER',
  'HALLUCINATED_API',
  'HALLUCINATED_FILE',
  'REFUSAL_WRONG',
  'NO_EVIDENCE',
  'ERROR',
];

export function scorePairedExperiment(input: PairedExperimentScoringInput): ExperimentScorecard {
  const guardrails = input.guardrails ?? {};
  const minPairedTasksForKeep = guardrails.minPairedTasksForKeep ?? 20;
  const minCandidateNetWins = guardrails.minCandidateNetWins ?? 1;
  const maxLatencyRegressionRatio = guardrails.maxLatencyRegressionRatio ?? 1.25;
  const maxToolCallRegressionRatio = guardrails.maxToolCallRegressionRatio ?? 1.5;
  const rejectOnFailureCategoryIncrease = guardrails.rejectOnFailureCategoryIncrease ?? DEFAULT_REJECT_CATEGORIES;
  const requireNoSafetyRegressions = guardrails.requireNoSafetyRegressions ?? true;

  const candidateByTask = new Map(input.candidateRun.results.map((result) => [result.taskId, result]));
  const taskDiffs: PairedTaskDiff[] = [];
  let bothPass = 0;
  let bothFail = 0;
  let candidateOnlyPass = 0;
  let baselineOnlyPass = 0;

  for (const baselineResult of input.baselineRun.results) {
    const candidateResult = candidateByTask.get(baselineResult.taskId);
    if (!candidateResult) continue;
    const baselinePassed = baselineResult.status === 'pass';
    const candidatePassed = candidateResult.status === 'pass';
    let outcome: PairedTaskDiff['outcome'];
    if (baselinePassed && candidatePassed) {
      bothPass += 1;
      outcome = 'both_pass';
    } else if (!baselinePassed && !candidatePassed) {
      bothFail += 1;
      outcome = 'both_fail';
    } else if (candidatePassed) {
      candidateOnlyPass += 1;
      outcome = 'candidate_only_pass';
    } else {
      baselineOnlyPass += 1;
      outcome = 'baseline_only_pass';
    }
    taskDiffs.push({
      taskId: baselineResult.taskId,
      baselineStatus: baselineResult.status,
      candidateStatus: candidateResult.status,
      outcome,
      baselineFailureCategory: baselineResult.failureCategory,
      candidateFailureCategory: candidateResult.failureCategory,
    });
  }

  const pairedTasks = taskDiffs.length;
  const failureCategoryDeltas = diffFailureCounts(input.baselineRun.results, input.candidateRun.results);
  const averageDurationRatio = ratio(average(input.candidateRun.results.map((result) => result.durationMs)), average(input.baselineRun.results.map((result) => result.durationMs)));
  const averageToolCallRatio = ratio(average(input.candidateRun.results.map((result) => result.toolCalls.length)), average(input.baselineRun.results.map((result) => result.toolCalls.length)));
  const reasons: string[] = [];
  let hardRejected = false;

  if (requireNoSafetyRegressions && input.safety && input.safety.candidateViolations > input.safety.baselineViolations) {
    hardRejected = true;
    reasons.push(`Candidate safety violations increased from ${input.safety.baselineViolations} to ${input.safety.candidateViolations}.`);
  }

  for (const category of rejectOnFailureCategoryIncrease) {
    const delta = failureCategoryDeltas[category] ?? 0;
    if (delta > 0) {
      hardRejected = true;
      reasons.push(`Candidate increased ${category} failures by ${delta}.`);
    }
  }

  if (averageDurationRatio !== null && averageDurationRatio > maxLatencyRegressionRatio) {
    hardRejected = true;
    reasons.push(`Candidate average duration ratio ${averageDurationRatio.toFixed(2)} exceeded ${maxLatencyRegressionRatio}.`);
  }

  if (averageToolCallRatio !== null && averageToolCallRatio > maxToolCallRegressionRatio) {
    hardRejected = true;
    reasons.push(`Candidate average tool-call ratio ${averageToolCallRatio.toFixed(2)} exceeded ${maxToolCallRegressionRatio}.`);
  }

  const netCandidateWins = candidateOnlyPass - baselineOnlyPass;
  const decision = decide({ hardRejected, pairedTasks, minPairedTasksForKeep, netCandidateWins, minCandidateNetWins, reasons });

  return {
    baselineVariantId: input.baselineVariantId,
    candidateVariantId: input.candidateVariantId,
    pairedTasks,
    baselinePassRate: input.baselineRun.passRate,
    candidatePassRate: input.candidateRun.passRate,
    passRateDelta: input.candidateRun.passRate - input.baselineRun.passRate,
    paired: {
      bothPass,
      bothFail,
      candidateOnlyPass,
      baselineOnlyPass,
      netCandidateWins,
    },
    failureCategoryDeltas,
    averageDurationRatio,
    averageToolCallRatio,
    mcnemar: summarizeMcNemar(baselineOnlyPass, candidateOnlyPass),
    taskDiffs,
    decision,
  };
}

function decide(input: {
  hardRejected: boolean;
  pairedTasks: number;
  minPairedTasksForKeep: number;
  netCandidateWins: number;
  minCandidateNetWins: number;
  reasons: string[];
}): ExperimentScorecard['decision'] {
  if (input.hardRejected) {
    return { status: 'discard', reasons: input.reasons, automaticPromotionAllowed: false };
  }
  if (input.netCandidateWins < 0) {
    return {
      status: 'discard',
      reasons: [`Candidate lost ${Math.abs(input.netCandidateWins)} more paired task(s) than it won.`],
      automaticPromotionAllowed: false,
    };
  }
  if (input.pairedTasks < input.minPairedTasksForKeep) {
    return {
      status: 'inconclusive',
      reasons: [`Only ${input.pairedTasks} paired task(s) were evaluated; need ${input.minPairedTasksForKeep} before keep decisions.`],
      automaticPromotionAllowed: false,
    };
  }
  if (input.netCandidateWins >= input.minCandidateNetWins) {
    return {
      status: 'keep',
      reasons: [`Candidate won ${input.netCandidateWins} net paired task(s).`],
      automaticPromotionAllowed: true,
    };
  }
  return {
    status: 'inconclusive',
    reasons: [`Candidate net wins ${input.netCandidateWins} did not reach required ${input.minCandidateNetWins}.`],
    automaticPromotionAllowed: false,
  };
}

function diffFailureCounts(baseline: BenchmarkTaskResult[], candidate: BenchmarkTaskResult[]): Partial<Record<FailureCategory, number>> {
  const counts: Partial<Record<FailureCategory, number>> = {};
  for (const result of baseline) {
    if (!result.failureCategory) continue;
    counts[result.failureCategory] = (counts[result.failureCategory] ?? 0) - 1;
  }
  for (const result of candidate) {
    if (!result.failureCategory) continue;
    counts[result.failureCategory] = (counts[result.failureCategory] ?? 0) + 1;
  }
  return counts;
}

function summarizeMcNemar(baselineOnlyPasses: number, candidateOnlyPasses: number): ExperimentScorecard['mcnemar'] {
  const discordant = baselineOnlyPasses + candidateOnlyPasses;
  if (discordant === 0) {
    return {
      baselineOnlyPasses,
      candidateOnlyPasses,
      statisticWithContinuityCorrection: null,
      significantAt95: false,
    };
  }
  const statistic = Math.pow(Math.abs(candidateOnlyPasses - baselineOnlyPasses) - 1, 2) / discordant;
  return {
    baselineOnlyPasses,
    candidateOnlyPasses,
    statisticWithContinuityCorrection: statistic,
    significantAt95: statistic > 3.841,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return numerator === 0 ? 1 : null;
  return numerator / denominator;
}