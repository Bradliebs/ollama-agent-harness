// Capability Registry — runtime inventory of what the harness can do.
//
// Before promising ongoing reminders, notifications, or proactive updates,
// the harness checks whether the required capabilities actually exist.

export type CapabilityId =
  | 'scheduler'
  | 'local_files'
  | 'notifications'
  | 'email'
  | 'calendar'
  | 'browser'
  | 'shell'
  | 'code_runner'
  | 'test_runner'
  | 'vector_memory'
  | 'ollama'
  | 'cloud_models'
  | 'telegram';

export type CapabilityStatus = 'available' | 'unavailable' | 'degraded';

export interface Capability {
  id: CapabilityId;
  label: string;
  status: CapabilityStatus;
  reason?: string;
  checkedAt?: string;
}

export interface CapabilityCheckResult {
  id: CapabilityId;
  status: CapabilityStatus;
  reason: string;
}

export type CapabilityChecker = (id: CapabilityId) => CapabilityCheckResult | Promise<CapabilityCheckResult>;

// ─── Registry ───────────────────────────────────────────────────────

export class CapabilityRegistry {
  private capabilities = new Map<CapabilityId, Capability>();
  private checkers = new Map<CapabilityId, CapabilityChecker>();

  /** Register a capability with its current status. */
  register(id: CapabilityId, label: string, status: CapabilityStatus = 'available', reason?: string): void {
    this.capabilities.set(id, {
      id,
      label,
      status,
      reason,
      checkedAt: new Date().toISOString(),
    });
  }

  /** Register a dynamic checker for a capability. */
  registerChecker(id: CapabilityId, checker: CapabilityChecker): void {
    this.checkers.set(id, checker);
  }

  /** Check whether a capability is available. */
  has(id: CapabilityId): boolean {
    return this.capabilities.get(id)?.status === 'available';
  }

  /** Get a capability entry. */
  get(id: CapabilityId): Capability | undefined {
    return this.capabilities.get(id);
  }

  /** List all registered capabilities. */
  list(): Capability[] {
    return Array.from(this.capabilities.values());
  }

  /** List only available capabilities. */
  available(): Capability[] {
    return this.list().filter((c) => c.status === 'available');
  }

  /** List missing capabilities. */
  missing(): Capability[] {
    return this.list().filter((c) => c.status === 'unavailable');
  }

  /** Refresh a capability by running its checker. */
  async refresh(id: CapabilityId): Promise<Capability | undefined> {
    const checker = this.checkers.get(id);
    if (!checker) return this.capabilities.get(id);
    const result = await checker(id);
    this.capabilities.set(id, {
      id,
      label: this.capabilities.get(id)?.label ?? id,
      status: result.status,
      reason: result.reason,
      checkedAt: new Date().toISOString(),
    });
    return this.capabilities.get(id);
  }

  /** Refresh all capabilities with registered checkers. */
  async refreshAll(): Promise<Capability[]> {
    for (const id of this.checkers.keys()) {
      await this.refresh(id);
    }
    return this.list();
  }

  /** Check required capabilities for an operation. Returns missing ones. */
  checkRequired(required: CapabilityId[]): Capability[] {
    return required.filter((id) => !this.has(id)).map((id) => this.capabilities.get(id) ?? { id, label: id, status: 'unavailable' as CapabilityStatus, reason: 'Not registered.' });
  }

  /** Format a human-readable limitation message for missing capabilities. */
  formatLimitations(required: CapabilityId[]): string | null {
    const missing = this.checkRequired(required);
    if (missing.length === 0) return null;
    const names = missing.map((c) => c.label || c.id);
    return `The following capabilities are not available: ${names.join(', ')}. ` +
      'Persistent service state can be created, but features requiring these capabilities will not function until they are enabled.';
  }
}

// ─── Default registry factory ───────────────────────────────────────

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  // Always available in the harness
  registry.register('local_files', 'Local file system', 'available');
  registry.register('shell', 'Shell command execution', 'available');
  registry.register('code_runner', 'Code execution', 'available');
  registry.register('scheduler', 'Job scheduler', 'available');

  // Available if Ollama is expected to be running
  registry.register('ollama', 'Ollama LLM backend', 'available');

  // Not available by default — require explicit setup
  registry.register('notifications', 'Push notifications', 'unavailable', 'No notification pathway configured.');
  registry.register('email', 'Email sending', 'unavailable', 'No email transport configured.');
  registry.register('calendar', 'Calendar integration', 'unavailable', 'No calendar API configured.');
  registry.register('browser', 'Browser automation', 'unavailable', 'No browser tool configured.');
  registry.register('test_runner', 'Test runner', 'available');
  registry.register('vector_memory', 'Vector/semantic memory', 'unavailable', 'No embedding model configured.');
  registry.register('cloud_models', 'Cloud LLM backends', 'unavailable', 'No cloud API keys configured.');
  registry.register('telegram', 'Telegram messaging', 'unavailable', 'No Telegram bot token configured.');

  return registry;
}

// ─── Capability requirements for service features ───────────────────

export const SERVICE_FEATURE_REQUIREMENTS: Record<string, CapabilityId[]> = {
  proactive_reminders: ['scheduler', 'notifications'],
  daily_check_in: ['scheduler'],
  email_notifications: ['scheduler', 'email'],
  telegram_notifications: ['scheduler', 'telegram'],
  vector_search: ['vector_memory', 'ollama'],
  background_workers: ['scheduler', 'ollama'],
  cloud_reasoning: ['cloud_models'],
};

export function getFeatureRequirements(feature: string): CapabilityId[] {
  return SERVICE_FEATURE_REQUIREMENTS[feature] ?? [];
}
