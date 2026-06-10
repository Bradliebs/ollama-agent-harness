import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { BenchmarkTask } from '../eval/benchmark';
import { loadRegressionTasks, selectTasks } from '../eval/benchmark';
import { buildEvaluatorIdentity, validateExperimentManifest } from './manifest';
import type { ExperimentHoldoutSpec, ExperimentManifest, ResolvedExperimentPlan } from './types';

export interface ResolveExperimentOptions {
  projectDir: string;
  manifest: ExperimentManifest;
  tasks?: BenchmarkTask[];
  dryRun?: boolean;
}

export async function loadExperimentManifest(filePath: string): Promise<ExperimentManifest> {
  const raw = await fs.readFile(path.resolve(filePath), 'utf-8');
  return JSON.parse(raw) as ExperimentManifest;
}

export async function resolveExperimentPlan(options: ResolveExperimentOptions): Promise<ResolvedExperimentPlan> {
  const validation = validateExperimentManifest(options.manifest);
  if (!validation.ok) {
    throw new Error(`Invalid experiment manifest:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`);
  }

  const { BUILT_IN_TASKS } = await import('../eval/benchmarkTasks');
  const availableTasks = options.tasks ?? [...BUILT_IN_TASKS, ...(await loadRegressionTasks(options.projectDir))];
  const selectedTasks = selectTasks({
    tasks: availableTasks,
    filterIds: options.manifest.evaluation.taskIds,
    tiers: options.manifest.evaluation.tiers,
    perTaskTimeoutMs: options.manifest.evaluation.perTaskTimeoutMs,
  }, availableTasks);

  if (selectedTasks.length === 0) {
    throw new Error('Experiment selected zero benchmark tasks. Check evaluation.taskIds or evaluation.tiers.');
  }
  const maxTasks = options.manifest.budget?.maxTasks;
  if (maxTasks !== undefined && selectedTasks.length > maxTasks) {
    throw new Error(`Experiment selected ${selectedTasks.length} task(s), exceeding budget.maxTasks=${maxTasks}.`);
  }
  const maxCostUnits = options.manifest.budget?.maxCostUnits;
  const estimatedCostUnits = selectedTasks.length * 2;
  if (maxCostUnits !== undefined && estimatedCostUnits > maxCostUnits) {
    throw new Error(`Experiment requires ${estimatedCostUnits} cost unit(s), exceeding budget.maxCostUnits=${maxCostUnits}.`);
  }

  const evaluator = buildEvaluatorIdentity(options.manifest, selectedTasks);
  const selectedTaskIds = selectedTasks.map((task) => task.id);
  const holdoutTaskIds = resolveHoldoutTaskIds(options.manifest.evaluation.holdout, selectedTaskIds);
  return {
    manifest: options.manifest,
    evaluator,
    selectedTaskCount: selectedTasks.length,
    selectedTaskIds,
    holdoutTaskIds,
    dryRun: options.dryRun ?? false,
  };
}

// Deterministic [0,1) position for a task id (stable across runs/machines).
function stableUnitHash(taskId: string): number {
  const hex = crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

function resolveHoldoutTaskIds(holdout: ExperimentHoldoutSpec | undefined, selectedTaskIds: string[]): string[] | undefined {
  if (!holdout) return undefined;
  if (holdout.taskIds && holdout.taskIds.length > 0) {
    const selected = new Set(selectedTaskIds);
    const resolved = holdout.taskIds.filter((id) => selected.has(id));
    if (resolved.length === 0) {
      throw new Error('evaluation.holdout.taskIds matched none of the selected tasks.');
    }
    return resolved;
  }
  if (holdout.fraction !== undefined) {
    const resolved = selectedTaskIds.filter((id) => stableUnitHash(id) < holdout.fraction!);
    if (resolved.length === 0) {
      throw new Error(`evaluation.holdout.fraction=${holdout.fraction} produced an empty holdout for ${selectedTaskIds.length} selected task(s).`);
    }
    if (resolved.length === selectedTaskIds.length) {
      throw new Error(`evaluation.holdout.fraction=${holdout.fraction} held out every selected task, leaving no development set.`);
    }
    return resolved;
  }
  return undefined;
}

export async function resolveExperimentTasks(options: ResolveExperimentOptions): Promise<BenchmarkTask[]> {
  const plan = await resolveExperimentPlan(options);
  const { BUILT_IN_TASKS } = await import('../eval/benchmarkTasks');
  const availableTasks = options.tasks ?? [...BUILT_IN_TASKS, ...(await loadRegressionTasks(options.projectDir))];
  const taskIds = new Set(plan.selectedTaskIds);
  return availableTasks.filter((task) => taskIds.has(task.id));
}