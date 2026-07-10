import type { BenchmarkRun, BenchmarkTask } from '../eval/benchmark';
import { DEFAULT_SAFETY_RULES, scanSafetyText, type SafetyRule } from '../learning/promotionGate';
import type { ExperimentPromotionEvidence, ExperimentSafetyEvidence, ExperimentScorecard } from './types';

export function buildExperimentSafetyEvidence(
  tasks: BenchmarkTask[],
  baselineRun: BenchmarkRun,
  candidateRun: BenchmarkRun,
  rules: SafetyRule[] = DEFAULT_SAFETY_RULES,
): ExperimentSafetyEvidence {
  const taskInputById = new Map(tasks.map((task) => [task.id, task.input]));
  const baselineRules = collectRunViolationRules(baselineRun, taskInputById, rules);
  const candidateRules = collectRunViolationRules(candidateRun, taskInputById, rules);
  return {
    baselineViolations: baselineRules.length,
    candidateViolations: candidateRules.length,
    baselineViolationRules: Array.from(new Set(baselineRules)).sort(),
    candidateViolationRules: Array.from(new Set(candidateRules)).sort(),
  };
}

export function buildExperimentPromotionEvidence(scorecard: ExperimentScorecard): ExperimentPromotionEvidence {
  const status = scorecard.decision.status === 'keep'
    ? 'experiment_confirmed'
    : scorecard.decision.status === 'discard'
      ? 'experiment_regressed'
      : 'experiment_inconclusive';
  return {
    status,
    candidateVariantId: scorecard.candidateVariantId,
    baselineVariantId: scorecard.baselineVariantId,
    automaticPromotionAllowed: scorecard.decision.automaticPromotionAllowed,
    reasons: scorecard.decision.reasons,
    passRateDelta: scorecard.passRateDelta,
    netCandidateWins: scorecard.paired.netCandidateWins,
  };
}

function collectRunViolationRules(run: BenchmarkRun, taskInputById: Map<string, string>, rules: SafetyRule[]): string[] {
  const ruleIds: string[] = [];
  for (const result of run.results) {
    const input = taskInputById.get(result.taskId) ?? '';
    ruleIds.push(...scanSafetyText(input, 'prompt', rules).map((violation) => violation.ruleId));
    ruleIds.push(...scanSafetyText(result.responsePreview, 'outcome', rules).map((violation) => violation.ruleId));
    for (const toolName of result.toolCalls) {
      ruleIds.push(...scanSafetyText(toolName, 'tool_name', rules).map((violation) => violation.ruleId));
    }
  }
  return ruleIds;
}