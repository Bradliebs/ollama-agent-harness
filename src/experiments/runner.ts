import * as crypto from 'crypto';
import { runBenchmark, type BenchmarkRunOptions } from '../eval/benchmark';
import { loadSafetyRules } from '../learning/promotionGate';
import { buildExperimentPromotionEvidence, buildExperimentSafetyEvidence } from './evidence';
import { scorePairedExperiment } from './scoring';
import { persistExperimentExecution, persistExperimentPlan } from './persistence';
import { resolveExperimentPlan, resolveExperimentTasks } from './resolver';
import type { ExperimentExecutionRecord, ExperimentManifest, ResolvedExperimentPlan } from './types';

export interface RunExperimentOptions {
  projectDir: string;
  manifest: ExperimentManifest;
  dryRun?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  persist?: boolean;
  now?: () => Date;
}

export type RunExperimentResult =
  | { type: 'dry_run'; plan: ResolvedExperimentPlan }
  | { type: 'completed'; record: ExperimentExecutionRecord };

export async function runExperiment(options: RunExperimentOptions): Promise<RunExperimentResult> {
  const persist = options.persist ?? true;
  const now = options.now ?? (() => new Date());
  const plan = await resolveExperimentPlan({ projectDir: options.projectDir, manifest: options.manifest, dryRun: options.dryRun });
  if (options.dryRun) {
    if (persist) await persistExperimentPlan(options.projectDir, plan);
    return { type: 'dry_run', plan };
  }

  const tasks = await resolveExperimentTasks({ projectDir: options.projectDir, manifest: options.manifest });
  const startedAt = now();
  const commonOptions: Omit<BenchmarkRunOptions, 'model'> = {
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    tasks,
    filterIds: plan.selectedTaskIds,
    perTaskTimeoutMs: options.manifest.evaluation.perTaskTimeoutMs,
    replicates: options.manifest.evaluation.replicates,
  };

  const baselineRun = await runBenchmark({
    ...commonOptions,
    model: options.manifest.baseline.model,
    systemPrompt: options.manifest.baseline.systemPrompt,
  });
  enforceElapsedBudget(options.manifest, startedAt, now());
  const candidateRun = await runBenchmark({
    ...commonOptions,
    model: options.manifest.candidate.model,
    systemPrompt: options.manifest.candidate.systemPrompt,
  });
  const finishedAt = now();
  enforceElapsedBudget(options.manifest, startedAt, finishedAt);
  enforceToolCallBudget(options.manifest, baselineRun, candidateRun);
  const safetyRules = await loadSafetyRules(options.projectDir).catch(() => undefined);
  const safety = buildExperimentSafetyEvidence(tasks, baselineRun, candidateRun, safetyRules);
  const scorecard = scorePairedExperiment({
    baselineVariantId: options.manifest.baseline.id,
    candidateVariantId: options.manifest.candidate.id,
    baselineRun,
    candidateRun,
    guardrails: options.manifest.guardrails,
    safety,
    holdoutTaskIds: plan.holdoutTaskIds,
  });
  const promotionEvidence = buildExperimentPromotionEvidence(scorecard);
  const record: ExperimentExecutionRecord = {
    id: `exprun-${startedAt.getTime()}-${crypto.randomBytes(3).toString('hex')}`,
    manifest: options.manifest,
    evaluator: plan.evaluator,
    baselineRun,
    candidateRun,
    safety,
    scorecard,
    promotionEvidence,
    dryRun: false,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
  if (persist) await persistExperimentExecution(options.projectDir, record);
  return { type: 'completed', record };
}

function enforceElapsedBudget(manifest: ExperimentManifest, startedAt: Date, checkedAt: Date): void {
  const maxDurationMs = manifest.budget?.maxDurationMs;
  if (maxDurationMs === undefined) return;
  const elapsedMs = checkedAt.getTime() - startedAt.getTime();
  if (elapsedMs > maxDurationMs) {
    throw new Error(`Experiment exceeded budget.maxDurationMs=${maxDurationMs}; elapsed ${elapsedMs}ms.`);
  }
}

function enforceToolCallBudget(
  manifest: ExperimentManifest,
  baselineRun: NonNullable<ExperimentExecutionRecord['baselineRun']>,
  candidateRun: NonNullable<ExperimentExecutionRecord['candidateRun']>,
): void {
  const maxToolCalls = manifest.budget?.maxToolCalls;
  if (maxToolCalls === undefined) return;
  const toolCalls = [...baselineRun.results, ...candidateRun.results]
    .reduce((total, result) => total + result.toolCalls.length, 0);
  if (toolCalls > maxToolCalls) {
    throw new Error(`Experiment used ${toolCalls} tool call(s), exceeding budget.maxToolCalls=${maxToolCalls}.`);
  }
}