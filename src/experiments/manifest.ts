import type { BenchmarkTask } from '../eval/benchmark';
import type { EvaluatorIdentity, ExperimentManifest, ExperimentMutationScope } from './types';

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

const VALID_MUTATION_SCOPES: ReadonlySet<ExperimentMutationScope> = new Set([
  'model',
  'prompt',
  'skill',
  'tool_config',
  'routing_config',
  'retrieval_config',
  'none',
]);

export function validateExperimentManifest(manifest: ExperimentManifest): ManifestValidationResult {
  const errors: string[] = [];
  requireNonEmpty(errors, manifest.id, 'id');
  requireNonEmpty(errors, manifest.hypothesis, 'hypothesis');
  requireNonEmpty(errors, manifest.expectedMechanism, 'expectedMechanism');
  requireNonEmpty(errors, manifest.rollbackTarget, 'rollbackTarget');
  requireNonEmpty(errors, manifest.baseline?.id, 'baseline.id');
  requireNonEmpty(errors, manifest.baseline?.label, 'baseline.label');
  requireNonEmpty(errors, manifest.candidate?.id, 'candidate.id');
  requireNonEmpty(errors, manifest.candidate?.label, 'candidate.label');
  requireNonEmpty(errors, manifest.evaluation?.datasetId, 'evaluation.datasetId');
  requireNonEmpty(errors, manifest.evaluation?.scorerVersion, 'evaluation.scorerVersion');

  if (!Array.isArray(manifest.allowedMutationScopes) || manifest.allowedMutationScopes.length === 0) {
    errors.push('allowedMutationScopes must include at least one scope.');
  } else {
    for (const scope of manifest.allowedMutationScopes) {
      if (!VALID_MUTATION_SCOPES.has(scope)) errors.push(`allowedMutationScopes contains unknown scope: ${scope}.`);
    }
    if (manifest.allowedMutationScopes.includes('none') && manifest.allowedMutationScopes.length > 1) {
      errors.push('allowedMutationScopes cannot combine none with mutable scopes.');
    }
  }

  if (manifest.baseline?.id && manifest.candidate?.id && manifest.baseline.id === manifest.candidate.id) {
    errors.push('baseline.id and candidate.id must be distinct.');
  }
  if (manifest.evaluation?.taskIds && manifest.evaluation.taskIds.length === 0) {
    errors.push('evaluation.taskIds cannot be empty when provided.');
  }
  if (manifest.evaluation?.tiers && manifest.evaluation.tiers.length === 0) {
    errors.push('evaluation.tiers cannot be empty when provided.');
  }
  if (manifest.evaluation?.perTaskTimeoutMs !== undefined && manifest.evaluation.perTaskTimeoutMs <= 0) {
    errors.push('evaluation.perTaskTimeoutMs must be positive when provided.');
  }
  if (manifest.evaluation?.replicates !== undefined
    && (!Number.isInteger(manifest.evaluation.replicates) || manifest.evaluation.replicates < 1)) {
    errors.push('evaluation.replicates must be a positive integer when provided.');
  }
  const holdout = manifest.evaluation?.holdout;
  if (holdout) {
    const hasTaskIds = holdout.taskIds !== undefined;
    const hasFraction = holdout.fraction !== undefined;
    if (hasTaskIds && hasFraction) {
      errors.push('evaluation.holdout cannot set both fraction and taskIds.');
    }
    if (!hasTaskIds && !hasFraction) {
      errors.push('evaluation.holdout must set either fraction or taskIds.');
    }
    if (hasTaskIds && (holdout.taskIds!.length === 0)) {
      errors.push('evaluation.holdout.taskIds cannot be empty when provided.');
    }
    if (hasFraction && !(holdout.fraction! > 0 && holdout.fraction! < 1)) {
      errors.push('evaluation.holdout.fraction must be between 0 and 1 (exclusive) when provided.');
    }
  }
  if (manifest.budget?.maxTasks !== undefined && manifest.budget.maxTasks <= 0) {
    errors.push('budget.maxTasks must be positive when provided.');
  }
  if (manifest.budget?.maxDurationMs !== undefined && manifest.budget.maxDurationMs <= 0) {
    errors.push('budget.maxDurationMs must be positive when provided.');
  }
  if (manifest.budget?.maxCostUnits !== undefined && manifest.budget.maxCostUnits <= 0) {
    errors.push('budget.maxCostUnits must be positive when provided.');
  }
  if (manifest.budget?.maxToolCalls !== undefined && manifest.budget.maxToolCalls < 0) {
    errors.push('budget.maxToolCalls cannot be negative when provided.');
  }

  return { ok: errors.length === 0, errors };
}

export function buildEvaluatorIdentity(manifest: ExperimentManifest, selectedTasks: BenchmarkTask[]): EvaluatorIdentity {
  const selectedTaskIds = selectedTasks.map((task) => task.id).sort();
  const selectedTiers = Array.from(new Set(selectedTasks.map((task) => task.tier))).sort();
  return {
    datasetId: manifest.evaluation.datasetId,
    scorerVersion: manifest.evaluation.scorerVersion,
    taskIds: selectedTaskIds,
    tiers: selectedTiers,
    perTaskTimeoutMs: manifest.evaluation.perTaskTimeoutMs,
  };
}

function requireNonEmpty(errors: string[], value: string | undefined, field: string): void {
  if (!value || value.trim().length === 0) errors.push(`${field} is required.`);
}