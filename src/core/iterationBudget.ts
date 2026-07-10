/**
 * IterationBudget — turn-counting primitive used by the query loop and
 * subagents under `HARNESS_LOOP_HARDENING=1`. Borrowed from the Hermes
 * `iteration_budget.py` design: callers spend a turn with `consume()` and
 * may `refund()` a turn that did only programmatic-only work (e.g. the
 * model invoked one harness-internal meta tool such as `memory_write` and
 * the next turn is just a bookkeeping continuation). Without refund, every
 * meta-only turn permanently eats real budget; with refund, long
 * autonomous runs spend their budget on substantive turns.
 *
 * The primitive is intentionally tiny and side-effect free. It does NOT
 * decide what counts as refundable — that lives at the call site, where
 * the decision can read tool-call shape and configuration. The budget
 * only enforces the invariants:
 *
 *  - `consume()` cannot drop `used` below 0 or above `total`.
 *  - `refund()` cannot push `used` below 0.
 *  - Calling `refund()` more than `consume()` is a no-op (silently caps).
 *
 * Default behaviour without the env flag is byte-identical to the old
 * `turn++ / while (turn < maxTurns)` shape: callers either don't construct
 * a budget at all, or construct one and never call `refund()`.
 */
export type RefundReason =
  | 'programmatic_only'
  | 'meta_tool_only'
  | 'housekeeping';

export interface RefundEvent {
  reason: RefundReason;
  /** Total used count after the refund (post-decrement). */
  usedAfter: number;
}

export class IterationBudget {
  private used = 0;
  private readonly refundLog: RefundEvent[] = [];

  constructor(public readonly total: number) {
    if (!Number.isFinite(total) || total < 0) {
      throw new Error(`IterationBudget total must be a finite non-negative number, got ${total}`);
    }
  }

  /** Record one consumed turn. Returns the new `used` count. */
  consume(): number {
    if (this.used < this.total) this.used += 1;
    return this.used;
  }

  /**
   * Return one turn to the budget. Caps at `used >= 0` so a stray refund
   * cannot create negative-used budget. Returns whether the refund actually
   * fired (false if `used` was already 0 — the budget is fully unspent).
   */
  refund(reason: RefundReason): boolean {
    if (this.used <= 0) return false;
    this.used -= 1;
    this.refundLog.push({ reason, usedAfter: this.used });
    return true;
  }

  /** Spent turns. */
  get spent(): number {
    return this.used;
  }

  /** Remaining turns before the budget is exhausted. */
  get remaining(): number {
    return Math.max(0, this.total - this.used);
  }

  /** True when no further `consume()` can fire without exceeding `total`. */
  get exhausted(): boolean {
    return this.used >= this.total;
  }

  /** Read-only view of refund events for telemetry. */
  refunds(): readonly RefundEvent[] {
    return this.refundLog;
  }
}

/**
 * Resolve whether the loop hardening features (iteration refund,
 * surrogate sanitisation, retry-state recovery branches) are enabled.
 * Single env knob keeps the slice atomic for AutoResearch A/B comparison.
 */
export function resolveLoopHardeningEnabled(): boolean {
  const env = process.env.HARNESS_LOOP_HARDENING?.toLowerCase();
  return env === '1' || env === 'on' || env === 'true';
}
