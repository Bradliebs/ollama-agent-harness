/**
 * TurnRetryState — one-shot recovery flag set scoped to a single chat
 * client retry attempt. Borrowed from the Hermes `turn_retry_state.py`
 * design: a chat call may need several flavours of recovery (compress
 * context on overflow, rotate credential on auth, fall back to a smaller
 * model on overload, strip thinking signatures, shrink images), and each
 * one is appropriate AT MOST once per chat call. Without a per-attempt
 * gate, a transient failure can ping-pong the same recovery branch
 * forever; with a gate, each branch fires once and then the loop falls
 * through to a hard error.
 *
 * Construct fresh per chat-client retry attempt — DO NOT reuse across
 * unrelated calls. The state is intentionally not exported as a global.
 */

export type RecoveryFlag =
  | 'compressedContext'
  | 'rotatedCredential'
  | 'falledBackModel'
  | 'strippedThinkingSignature'
  | 'shrunkImages'
  | 'reformattedRequest'
  | 'rateLimitBackoff'
  | 'transportFallback';

export class TurnRetryState {
  private readonly fired = new Set<RecoveryFlag>();

  /**
   * Atomically check-and-set a recovery flag. Returns `true` the first
   * time `flag` is requested in this state's lifetime, `false` on every
   * subsequent call. Callers fire the recovery branch only when true.
   *
   * Pattern:
   *   if (state.tryFire('compressedContext')) {
   *     await compressContext();
   *     continue; // retry
   *   } else {
   *     throw error; // already tried compression on this attempt
   *   }
   */
  tryFire(flag: RecoveryFlag): boolean {
    if (this.fired.has(flag)) return false;
    this.fired.add(flag);
    return true;
  }

  /** True when `flag` has already fired in this state's lifetime. */
  hasFired(flag: RecoveryFlag): boolean {
    return this.fired.has(flag);
  }

  /** Read-only view of fired flags for telemetry. */
  firedFlags(): readonly RecoveryFlag[] {
    return Array.from(this.fired);
  }

  /** Discard all flags. Intended for tests; production should construct fresh. */
  reset(): void {
    this.fired.clear();
  }
}
