/**
 * Sandbox switch — companion to {@link ../permissions/killSwitch}.
 *
 * Sandbox is a SOFT containment mode. Unlike the kill switch (which denies
 * every tool call outright), sandbox keeps tools working but narrows what
 * they can do:
 *   - filesystem writes/reads confined to PROJECT_DIR (no allowed-external
 *     escape, no `..` traversal)
 *   - shell tool restricted to a curated binary allowlist
 *   - network tools blocked from private / loopback / link-local hosts
 *
 * The class is intentionally a near-clone of {@link KillSwitch} so the two
 * switches behave the same from a state-management perspective (same
 * engage/release/snapshot/restore/onChange surface, same persistence
 * semantics, same listener-crash isolation). One process-wide instance lives
 * on the server; tool modules read its state via a setter wired in
 * `tools/sandboxGuards.ts` to keep the dependency edge one-way (permissions
 * is allowed to be imported by tools, but not the other way).
 */

export interface SandboxState {
  active: boolean;
  reason: string;
}

export type SandboxListener = (state: SandboxState) => void;

const DEFAULT_REASON = 'Sandbox engaged.';

export class SandboxSwitch {
  private state: SandboxState = { active: false, reason: '' };
  private listeners: Set<SandboxListener> = new Set();

  isActive(): boolean {
    return this.state.active;
  }

  getReason(): string {
    return this.state.reason;
  }

  /** Return a defensive copy so callers cannot mutate internal state. */
  snapshot(): SandboxState {
    return { active: this.state.active, reason: this.state.reason };
  }

  /**
   * Engage sandbox with an optional human-readable reason. Idempotent but
   * always overwrites the reason so the most recent operator note wins.
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
   * Restore from a persisted snapshot. Does not fire listeners — startup
   * restoration is observed via the initial settings load, not as a state
   * transition.
   */
  restore(snapshot: Partial<SandboxState> | null | undefined): void {
    const active = Boolean(snapshot?.active);
    const reason = active
      ? (typeof snapshot?.reason === 'string' && snapshot.reason.trim()
          ? snapshot.reason.slice(0, 500)
          : 'Sandbox restored from saved state.')
      : '';
    this.state = { active, reason };
  }

  /** Subscribe to engage/release transitions. Returns an unsubscribe fn. */
  onChange(listener: SandboxListener): () => void {
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
        // A listener crash must never break the sandbox itself. Listeners
        // are best-effort (audit logs, metrics, tray-icon updates, etc.).
      }
    }
  }
}
