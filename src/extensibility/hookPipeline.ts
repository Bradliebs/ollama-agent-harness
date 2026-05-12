import type { Hook, HookContext, HookResult, HookEventType } from '../types';

export class HookPipeline {
  private hooks: Map<HookEventType, Hook[]> = new Map();

  register(hook: Hook): void {
    const existing = this.hooks.get(hook.eventType) ?? [];
    existing.push(hook);
    this.hooks.set(hook.eventType, existing);
  }

  unregister(name: string): void {
    for (const [eventType, hooks] of this.hooks) {
      this.hooks.set(
        eventType,
        hooks.filter((h) => h.name !== name),
      );
    }
  }

  async execute(context: HookContext): Promise<HookResult> {
    const hooks = this.hooks.get(context.eventType) ?? [];

    let aggregated: HookResult = { action: 'continue' };

    for (const hook of hooks) {
      try {
        const result = await hook.handler(context);

        // Block takes precedence — if any hook blocks, stop immediately
        if (result.action === 'block') {
          return result;
        }

        // Modify accumulates changes
        if (result.action === 'modify') {
          if (result.modifiedInput) {
            context = { ...context, toolInput: result.modifiedInput };
          }
          if (result.modifiedOutput) {
            context = { ...context, toolOutput: result.modifiedOutput };
          }
          aggregated = result;
        }

        // Accumulate additional context
        if (result.additionalContext) {
          aggregated.additionalContext = [
            aggregated.additionalContext,
            result.additionalContext,
          ]
            .filter(Boolean)
            .join('\n');
        }
      } catch (error) {
        // Hooks should not crash the pipeline — log and continue
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Hook '${hook.name}' failed: ${msg}`);
      }
    }

    return aggregated;
  }

  getRegisteredHooks(): ReadonlyArray<{ name: string; eventType: HookEventType }> {
    const result: Array<{ name: string; eventType: HookEventType }> = [];
    for (const [eventType, hooks] of this.hooks) {
      for (const hook of hooks) {
        result.push({ name: hook.name, eventType });
      }
    }
    return result;
  }
}
