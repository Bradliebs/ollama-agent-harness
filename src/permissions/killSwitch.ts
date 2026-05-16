/**
 * Single source of truth for the global kill switch.
 *
 * Background: prior to v0.5.6 the server held its own `killSwitchActive`
 * boolean while every `PermissionEngine` instance kept a private copy that
 * was snapshotted at construction time. Per-session engines therefore could
 * not see kill-switch changes made after the session started; conversely,
 * code that called `engine.engageKillSwitch()` directly never propagated
 * back to the server flag the schedulers were reading. Audit item #6
 * captured this drift risk.
 *
 * `KillSwitch` centralises the state. The server owns one instance; the
 * permission engine accepts that instance and reads through it on every
 * `evaluate()` call, so every consumer always sees live state.
 *
 * Persistence stays the same: the server snapshots and restores via
 * `snapshot()` / `restore()` against `settings.json`.
 */

export interface KillSwitchState {
  active: boolean;
  reason: string;
}

export type KillSwitchListener = (state: KillSwitchState) => void;

const DEFAULT_REASON = 'Kill switch engaged.';

export class KillSwitch {
  private state: KillSwitchState = { active: false, reason: '' };
  private listeners: Set<KillSwitchListener> = new Set();

  isActive(): boolean {
    return this.state.active;
  }

  getReason(): string {
    return this.state.reason;
  }

  /** Return a defensive copy so callers cannot mutate internal state. */
  snapshot(): KillSwitchState {
    return { active: this.state.active, reason: this.state.reason };
  }

  /**
   * Engage the kill switch with an optional human-readable reason. Idempotent
   * but always overwrites the reason so the most recent operator note wins.
   */
  engage(reason: string = DEFAULT_REASON): void {
    const trimmed = typeof reason === 'string' && reason.trim() ? reason : DEFAULT_REASON;
    this.state = { active: true, reason: trimmed };
    this.emit();
  }

  release(): void {
    this.state = { active: false, reason: '' };
    this.emit();
  }

  /**
   * Restore from a persisted snapshot (e.g. `settings.json`). Does not fire
   * listeners — startup restoration is observed via the initial settings
   * load, not as a state-change event.
   */
  restore(snapshot: Partial<KillSwitchState> | null | undefined): void {
    const active = Boolean(snapshot?.active);
    const reason = active
      ? (typeof snapshot?.reason === 'string' && snapshot.reason.trim()
          ? snapshot.reason.slice(0, 500)
          : 'Kill switch restored from saved state.')
      : '';
    this.state = { active, reason };
  }

  /** Subscribe to engage/release transitions. Returns an unsubscribe fn. */
  onChange(listener: KillSwitchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // A listener crash must never break the kill switch itself. Listeners
        // are best-effort (audit logs, metrics, etc.).
      }
    }
  }
}
