import { emitEvent, queryEvents, type HarnessEvent } from '../persistence/eventStore';
import type { ExperimentExecutionRecord, ResolvedExperimentPlan } from './types';

export type ExperimentEventType = 'experiment_dry_run' | 'experiment_completed';

export async function persistExperimentPlan(projectDir: string, plan: ResolvedExperimentPlan): Promise<HarnessEvent> {
  return emitEvent(
    projectDir,
    'experiment',
    'experiment_dry_run',
    plan as unknown as Record<string, unknown>,
    'system',
    plan.manifest.id,
  );
}

export async function persistExperimentExecution(projectDir: string, record: ExperimentExecutionRecord): Promise<HarnessEvent> {
  return emitEvent(
    projectDir,
    'experiment',
    'experiment_completed',
    record as unknown as Record<string, unknown>,
    'system',
    record.manifest.id,
  );
}

export async function listExperimentEvents(projectDir: string, experimentId?: string): Promise<HarnessEvent[]> {
  return queryEvents(projectDir, {
    category: 'experiment',
    ...(experimentId ? { subject_id: experimentId } : {}),
  });
}