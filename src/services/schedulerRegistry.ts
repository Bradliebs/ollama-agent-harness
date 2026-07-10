/**
 * Centralised lifecycle registry for the server's long-running schedulers.
 *
 * Audit item #6 (v0.5.6): before this registry, each scheduler
 * (CuratorScheduler, SelfLearningHeartbeat, TriggerScheduler,
 * AutomationScheduler, uploads-auto-prune, OTLP exporter) was wired
 * independently in `server.ts` with its own `configureX` / `stopX` pair.
 * There was no single place to enumerate what was running, stop everything
 * for shutdown, or audit which subsystems were active.
 *
 * `SchedulerRegistry` is deliberately small: register a `ManagedScheduler`,
 * stop a specific one by name, stop all in reverse-registration order,
 * enumerate current status. It does NOT subscribe to the KillSwitch — the
 * existing semantic is that schedulers stay running but their per-tick guard
 * (`isKillSwitchActive()`) makes them no-op while the switch is engaged.
 * That preserves the current behaviour where releasing the switch resumes
 * scheduled work without a reconfiguration.
 */

export interface ManagedScheduler {
  /** Stable identifier used for lookup and stop ordering. */
  readonly name: string;
  /** Stop the scheduler. May be sync or async; errors are swallowed and reported. */
  stop(): void | Promise<void>;
  /** Optional liveness probe used by `list()`. Defaults to `true` if omitted. */
  isRunning?(): boolean;
  /**
   * Optional restart hook. When present, the scheduler can be brought back
   * after a `stop()` without a server restart — typically by calling the same
   * idempotent `configureX()` that registered it. Schedulers that have no
   * clean re-create path (e.g. startup-only inline timers) omit this, and the
   * UI then offers Stop only, not Start.
   */
  restart?(): void | Promise<void>;
}

export interface SchedulerStatus {
  name: string;
  running: boolean;
  /** True when the entry exposes a `restart()` hook (UI can offer Start). */
  restartable: boolean;
}

export interface SchedulerStopResult {
  name: string;
  ok: boolean;
  error?: string;
}

export class SchedulerRegistry {
  private entries: ManagedScheduler[] = [];

  /**
   * Register (or replace) a scheduler. Replacing an existing entry by name
   * stops the previous instance first to avoid leaking timers when a
   * scheduler is reconfigured (curator, heartbeat, etc.).
   */
  register(scheduler: ManagedScheduler): void {
    if (!scheduler?.name || typeof scheduler.name !== 'string') {
      throw new Error('SchedulerRegistry.register: scheduler.name is required');
    }
    const existingIdx = this.entries.findIndex((entry) => entry.name === scheduler.name);
    if (existingIdx >= 0) {
      // Best-effort: stop the previous instance synchronously so callers that
      // immediately register a replacement do not double-fire timers. Async
      // stops are not awaited here — the new entry still goes in.
      const previous = this.entries[existingIdx];
      try { previous.stop(); } catch { /* swallow — replacement still wins */ }
      this.entries[existingIdx] = scheduler;
      return;
    }
    this.entries.push(scheduler);
  }

  /**
   * Unregister a scheduler by name without stopping it. Returns true if the
   * entry existed. Callers that want shutdown semantics should `stop()` first.
   */
  unregister(name: string): boolean {
    const idx = this.entries.findIndex((entry) => entry.name === name);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  /**
   * Stop a single scheduler by name. No-op if not registered.
   *
   * Schedulers typically unregister themselves inside `stop()` (their
   * `stopX()` helper clears the instance and calls `unregister`). For a
   * restartable scheduler that would make it vanish from `list()` entirely,
   * leaving no idle row for the UI to offer a Start control on. To preserve
   * the Start affordance, when a restartable entry removes itself during stop
   * we leave a lightweight tombstone: a non-running, restartable placeholder
   * carrying the same `restart()` hook. Calling `restart()` runs the
   * scheduler's idempotent configure path, which re-registers a live entry
   * and replaces the tombstone by name.
   */
  async stop(name: string): Promise<SchedulerStopResult | null> {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) return null;
    const restart = entry.restart;
    const result = await this.runStop(entry);
    const stillRegistered = this.entries.some((e) => e.name === name);
    if (restart && !stillRegistered) {
      this.entries.push({ name, stop: () => undefined, isRunning: () => false, restart });
    }
    return result;
  }

  /**
   * Restart a single scheduler by name using its `restart()` hook. Returns
   * `null` if the scheduler is not registered, and an `ok: false` result if it
   * has no `restart()` hook, the hook throws, or the scheduler is still not
   * running after the hook completes. The hook is expected to call the
   * scheduler's idempotent configure function, which re-registers the entry —
   * but that configure can early-return without starting anything if the
   * subsystem's enabled-guard is now false (e.g. it was disabled while
   * stopped). In that case the hook does not throw, yet the scheduler did not
   * come back, so we re-check `list()` and report `ok: false` rather than
   * claiming a success the operator can see is untrue.
   */
  async restart(name: string): Promise<SchedulerStopResult | null> {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) return null;
    if (!entry.restart) {
      return { name, ok: false, error: `Scheduler ${name} is not restartable` };
    }
    try {
      const result = entry.restart();
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
      const status = this.list().find((s) => s.name === name);
      if (!status || !status.running) {
        return { name, ok: false, error: `Scheduler ${name} did not start (it may be disabled in its settings)` };
      }
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Stop every registered scheduler in reverse-registration order so that
   * subsystems registered later (typically higher-level orchestrators) get a
   * chance to shut down before their dependencies disappear.
   *
   * Each stop is awaited but failures are isolated — one scheduler crashing
   * during shutdown must not prevent the others from being stopped.
   */
  async stopAll(): Promise<SchedulerStopResult[]> {
    const results: SchedulerStopResult[] = [];
    // Iterate over a snapshot in reverse — `stop()` may trigger unregisters
    // via callbacks, but the snapshot keeps iteration stable.
    const snapshot = [...this.entries].reverse();
    for (const entry of snapshot) {
      results.push(await this.runStop(entry));
    }
    return results;
  }

  /** Enumerate currently-registered schedulers with their liveness probe. */
  list(): SchedulerStatus[] {
    return this.entries.map((entry) => ({
      name: entry.name,
      running: entry.isRunning ? safeBool(() => entry.isRunning!()) : true,
      restartable: typeof entry.restart === 'function',
    }));
  }

  /** Test/diagnostic helper: drop all registrations without stopping. */
  clear(): void {
    this.entries = [];
  }

  private async runStop(entry: ManagedScheduler): Promise<SchedulerStopResult> {
    try {
      const result = entry.stop();
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
      return { name: entry.name, ok: true };
    } catch (error) {
      return {
        name: entry.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function safeBool(fn: () => boolean): boolean {
  try { return Boolean(fn()); } catch { return false; }
}
