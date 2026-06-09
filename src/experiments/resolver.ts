import * as fs from 'fs/promises';
import * as path from 'path';
import type { BenchmarkTask } from '../eval/benchmark';
import { loadRegressionTasks, selectTasks } from '../eval/benchmark';
import { buildEvaluatorIdentity, validateExperimentManifest } from './manifest';
import type { ExperimentManifest, ResolvedExperimentPlan } from './types';

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
  return {
    manifest: options.manifest,
    evaluator,
    selectedTaskCount: selectedTasks.length,
    selectedTaskIds: selectedTasks.map((task) => task.id),
    dryRun: options.dryRun ?? false,
  };
}

export async function resolveExperimentTasks(options: ResolveExperimentOptions): Promise<BenchmarkTask[]> {
  const plan = await resolveExperimentPlan(options);
  const { BUILT_IN_TASKS } = await import('../eval/benchmarkTasks');
  const availableTasks = options.tasks ?? [...BUILT_IN_TASKS, ...(await loadRegressionTasks(options.projectDir))];
  const taskIds = new Set(plan.selectedTaskIds);
  return availableTasks.filter((task) => taskIds.has(task.id));
}