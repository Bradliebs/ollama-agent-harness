// Model Router — selects the right model for each task type.
//
// Uses the ModelRegistry to pick local vs cloud models based on
// task type, cost, privacy, speed, complexity, and risk. The router
// does not ask one model to do everything.

import type { ModelRegistryEntry, ModelRole } from './modelRegistry';
import { ModelRegistry } from './modelRegistry';

export type RouterTaskType =
  | 'classification'
  | 'summarisation'
  | 'task_extraction'
  | 'note_cleanup'
  | 'daily_reminder'
  | 'log_scanning'
  | 'memory_compression'
  | 'codebase_scanning'
  | 'code_edit'
  | 'debugging'
  | 'test_explanation'
  | 'embedding'
  | 'vector_search'
  | 'architecture'
  | 'complex_reasoning'
  | 'ambiguous_planning'
  | 'difficult_debugging'
  | 'final_review'
  | 'json_validation'
  | 'general';

export interface ModelRoutingResult {
  model: ModelRegistryEntry | undefined;
  role: ModelRole;
  reason: string;
  fallback: boolean;
}

// ─── Task-to-role mapping ───────────────────────────────────────────

const TASK_ROLE_MAP: Record<RouterTaskType, ModelRole[]> = {
  classification:       ['local.general', 'local.summariser'],
  summarisation:        ['local.summariser', 'local.general'],
  task_extraction:      ['local.general', 'local.summariser'],
  note_cleanup:         ['local.general', 'local.summariser'],
  daily_reminder:       ['local.general', 'local.summariser'],
  log_scanning:         ['local.general'],
  memory_compression:   ['local.summariser', 'local.general'],
  codebase_scanning:    ['local.coder'],
  code_edit:            ['local.coder'],
  debugging:            ['local.coder', 'cloud.reasoner'],
  test_explanation:     ['local.coder'],
  embedding:            ['local.embedder'],
  vector_search:        ['local.embedder'],
  architecture:         ['cloud.reasoner'],
  complex_reasoning:    ['cloud.reasoner'],
  ambiguous_planning:   ['cloud.reasoner'],
  difficult_debugging:  ['cloud.reasoner', 'local.coder'],
  final_review:         ['cloud.reviewer', 'cloud.reasoner'],
  json_validation:      ['local.general'],
  general:              ['local.general', 'local.coder'],
};

// ─── Router ─────────────────────────────────────────────────────────

export class ModelRouter {
  constructor(private registry: ModelRegistry) {}

  /** Select the best model for a task. */
  route(taskType: RouterTaskType): ModelRoutingResult {
    const preferredRoles = TASK_ROLE_MAP[taskType] ?? TASK_ROLE_MAP.general;

    for (const role of preferredRoles) {
      const model = this.registry.bestForRole(role);
      if (model) {
        return {
          model,
          role,
          reason: `Selected ${model.model_name} (${role}) for ${taskType}.`,
          fallback: false,
        };
      }
    }

    // Fallback: any enabled model
    const allEnabled = this.registry.enabled();
    if (allEnabled.length > 0) {
      const fallbackModel = allEnabled[0];
      return {
        model: fallbackModel,
        role: fallbackModel.role,
        reason: `No model with preferred role for ${taskType}; falling back to ${fallbackModel.model_name}.`,
        fallback: true,
      };
    }

    return {
      model: undefined,
      role: preferredRoles[0],
      reason: `No enabled model available for ${taskType}.`,
      fallback: true,
    };
  }

  /** Route with a preference for local-only (privacy-sensitive). */
  routeLocal(taskType: RouterTaskType): ModelRoutingResult {
    const result = this.route(taskType);
    if (result.model?.privacy_level === 'local') return result;

    // Try local models only
    const localModels = this.registry.localModels();
    if (localModels.length > 0) {
      return {
        model: localModels[0],
        role: localModels[0].role,
        reason: `Privacy-sensitive: using local ${localModels[0].model_name} instead of cloud for ${taskType}.`,
        fallback: true,
      };
    }

    return result;
  }

  /** Route with a preference for cloud (complex task). */
  routeCloud(taskType: RouterTaskType): ModelRoutingResult {
    const cloudModels = this.registry.cloudModels();
    if (cloudModels.length > 0) {
      return {
        model: cloudModels[0],
        role: cloudModels[0].role,
        reason: `Cloud model ${cloudModels[0].model_name} selected for complex ${taskType}.`,
        fallback: false,
      };
    }

    // Fall back to local
    return this.route(taskType);
  }

  /** Check if cloud models are available and worth the cost for a task. */
  shouldEscalateToCloud(taskType: RouterTaskType): boolean {
    const cloudTasks: RouterTaskType[] = ['architecture', 'complex_reasoning', 'ambiguous_planning', 'difficult_debugging', 'final_review'];
    return cloudTasks.includes(taskType) && this.registry.cloudModels().length > 0;
  }

  /** Get routing explanation for a task. */
  explain(taskType: RouterTaskType): string {
    const result = this.route(taskType);
    if (!result.model) return `No model available for ${taskType}.`;
    const parts = [
      `Task: ${taskType}`,
      `Model: ${result.model.model_name} (${result.model.provider})`,
      `Role: ${result.role}`,
      `Cost: ${result.model.cost_level}`,
      `Privacy: ${result.model.privacy_level}`,
      `Speed: ${result.model.speed_level}`,
    ];
    if (result.fallback) parts.push('(fallback selection)');
    return parts.join(' | ');
  }
}
