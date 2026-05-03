// Model Registry — detailed model inventory with capability metadata.
//
// Each model entry includes strengths, weaknesses, cost, privacy, speed,
// context limits, JSON/tool support, and enabled state. The registry
// supports role-based lookup (local.general, cloud.reasoner, etc.).

export type ModelRole =
  | 'local.general'
  | 'local.coder'
  | 'local.summariser'
  | 'local.embedder'
  | 'cloud.reasoner'
  | 'cloud.reviewer';

export type CostLevel = 'free' | 'low' | 'medium' | 'high';
export type PrivacyLevel = 'local' | 'private_cloud' | 'public_cloud';
export type SpeedLevel = 'fast' | 'medium' | 'slow';

export interface ModelRegistryEntry {
  id: string;
  provider: string;
  base_url?: string;
  model_name: string;
  role: ModelRole;
  strengths: string[];
  weaknesses: string[];
  cost_level: CostLevel;
  privacy_level: PrivacyLevel;
  speed_level: SpeedLevel;
  max_context: number;
  supports_json: boolean;
  supports_tools: boolean;
  default_temperature: number;
  enabled: boolean;
}

export interface ModelRegistryManifest {
  version: 1;
  updated_at: string;
  models: ModelRegistryEntry[];
}

// ─── Built-in models ────────────────────────────────────────────────

export const BUILTIN_MODEL_REGISTRY: ModelRegistryEntry[] = [
  {
    id: 'llama3.1:8b',
    provider: 'ollama',
    base_url: 'http://127.0.0.1:11434',
    model_name: 'llama3.1:8b',
    role: 'local.general',
    strengths: ['classification', 'summarisation', 'task extraction', 'note cleanup', 'daily reminders', 'log scanning', 'memory compression'],
    weaknesses: ['complex reasoning', 'long-form code generation', 'multi-step planning'],
    cost_level: 'free',
    privacy_level: 'local',
    speed_level: 'fast',
    max_context: 8192,
    supports_json: true,
    supports_tools: false,
    default_temperature: 0.3,
    enabled: true,
  },
  {
    id: 'qwen2.5-coder:7b',
    provider: 'ollama',
    base_url: 'http://127.0.0.1:11434',
    model_name: 'qwen2.5-coder:7b',
    role: 'local.coder',
    strengths: ['codebase scanning', 'code edits', 'debugging drafts', 'test explanation', 'code review'],
    weaknesses: ['tool calling (emits JSON as text)', 'loop on reflect/promote_pattern'],
    cost_level: 'free',
    privacy_level: 'local',
    speed_level: 'fast',
    max_context: 32768,
    supports_json: true,
    supports_tools: false,
    default_temperature: 0.2,
    enabled: true,
  },
  {
    id: 'nomic-embed-text',
    provider: 'ollama',
    base_url: 'http://127.0.0.1:11434',
    model_name: 'nomic-embed-text',
    role: 'local.embedder',
    strengths: ['vector memory', 'semantic retrieval', 'document similarity'],
    weaknesses: ['no generation capability'],
    cost_level: 'free',
    privacy_level: 'local',
    speed_level: 'fast',
    max_context: 8192,
    supports_json: false,
    supports_tools: false,
    default_temperature: 0,
    enabled: true,
  },
  {
    id: 'llama3.1:8b-summariser',
    provider: 'ollama',
    base_url: 'http://127.0.0.1:11434',
    model_name: 'llama3.1:8b',
    role: 'local.summariser',
    strengths: ['summarisation', 'compression', 'daily note summaries', 'weekly review generation'],
    weaknesses: ['complex reasoning', 'code generation'],
    cost_level: 'free',
    privacy_level: 'local',
    speed_level: 'fast',
    max_context: 8192,
    supports_json: true,
    supports_tools: false,
    default_temperature: 0.2,
    enabled: true,
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    model_name: 'gpt-4.1',
    role: 'cloud.reasoner',
    strengths: ['architecture', 'complex reasoning', 'ambiguous planning', 'difficult debugging', 'high-quality final review'],
    weaknesses: ['cost', 'latency', 'privacy (data leaves local)'],
    cost_level: 'high',
    privacy_level: 'public_cloud',
    speed_level: 'medium',
    max_context: 128000,
    supports_json: true,
    supports_tools: true,
    default_temperature: 0.3,
    enabled: false,
  },
  {
    id: 'claude-3.5-sonnet',
    provider: 'anthropic',
    model_name: 'claude-3.5-sonnet',
    role: 'cloud.reviewer',
    strengths: ['code review', 'architecture review', 'safety assessment', 'nuanced reasoning'],
    weaknesses: ['cost', 'latency', 'privacy (data leaves local)'],
    cost_level: 'high',
    privacy_level: 'public_cloud',
    speed_level: 'medium',
    max_context: 200000,
    supports_json: true,
    supports_tools: true,
    default_temperature: 0.2,
    enabled: false,
  },
];

// ─── Registry class ─────────────────────────────────────────────────

export class ModelRegistry {
  private models = new Map<string, ModelRegistryEntry>();

  constructor(models: ModelRegistryEntry[] = BUILTIN_MODEL_REGISTRY) {
    for (const model of models) {
      this.models.set(model.id, { ...model });
    }
  }

  /** Get a model by ID. */
  get(id: string): ModelRegistryEntry | undefined {
    return this.models.get(id);
  }

  /** Register or update a model. */
  register(model: ModelRegistryEntry): void {
    this.models.set(model.id, model);
  }

  /** Remove a model. */
  remove(id: string): boolean {
    return this.models.delete(id);
  }

  /** List all models. */
  list(): ModelRegistryEntry[] {
    return Array.from(this.models.values());
  }

  /** List enabled models only. */
  enabled(): ModelRegistryEntry[] {
    return this.list().filter((m) => m.enabled);
  }

  /** Find models by role. */
  byRole(role: ModelRole): ModelRegistryEntry[] {
    return this.enabled().filter((m) => m.role === role);
  }

  /** Find the best model for a role, preferring enabled + lower cost. */
  bestForRole(role: ModelRole): ModelRegistryEntry | undefined {
    const candidates = this.byRole(role);
    if (candidates.length === 0) return undefined;
    const costOrder: CostLevel[] = ['free', 'low', 'medium', 'high'];
    candidates.sort((a, b) => costOrder.indexOf(a.cost_level) - costOrder.indexOf(b.cost_level));
    return candidates[0];
  }

  /** Find models that support tool calling. */
  withToolSupport(): ModelRegistryEntry[] {
    return this.enabled().filter((m) => m.supports_tools);
  }

  /** Find local models only. */
  localModels(): ModelRegistryEntry[] {
    return this.enabled().filter((m) => m.privacy_level === 'local');
  }

  /** Find cloud models only. */
  cloudModels(): ModelRegistryEntry[] {
    return this.enabled().filter((m) => m.privacy_level !== 'local');
  }

  /** Export the registry as a manifest. */
  toManifest(): ModelRegistryManifest {
    return {
      version: 1,
      updated_at: new Date().toISOString(),
      models: this.list(),
    };
  }

  /** Load from a manifest. */
  static fromManifest(manifest: ModelRegistryManifest): ModelRegistry {
    if (manifest.version !== 1 || !Array.isArray(manifest.models)) {
      throw new Error('Invalid model registry manifest.');
    }
    return new ModelRegistry(manifest.models);
  }
}
