import { IterationBudget, resolveLoopHardeningEnabled } from './iterationBudget';

describe('IterationBudget', () => {
  it('rejects non-finite or negative totals', () => {
    expect(() => new IterationBudget(NaN)).toThrow();
    expect(() => new IterationBudget(-1)).toThrow();
  });

  it('consume() spends one turn at a time and never exceeds total', () => {
    const b = new IterationBudget(3);
    expect(b.consume()).toBe(1);
    expect(b.consume()).toBe(2);
    expect(b.consume()).toBe(3);
    // Already at total: consume() is a no-op cap, never returns >total.
    expect(b.consume()).toBe(3);
    expect(b.exhausted).toBe(true);
    expect(b.remaining).toBe(0);
  });

  it('refund() returns one turn and never goes below zero', () => {
    const b = new IterationBudget(5);
    b.consume();
    b.consume();
    expect(b.spent).toBe(2);
    expect(b.refund('meta_tool_only')).toBe(true);
    expect(b.spent).toBe(1);
    expect(b.refund('meta_tool_only')).toBe(true);
    expect(b.spent).toBe(0);
    // Already at zero spent — refund silently no-ops, returns false.
    expect(b.refund('housekeeping')).toBe(false);
    expect(b.spent).toBe(0);
  });

  it('refunds keep the budget extendable past the original total', () => {
    const b = new IterationBudget(2);
    b.consume();
    b.consume();
    expect(b.exhausted).toBe(true);
    b.refund('meta_tool_only');
    expect(b.exhausted).toBe(false);
    expect(b.remaining).toBe(1);
    // The same physical turn slot can be reused after a refund.
    expect(b.consume()).toBe(2);
    expect(b.exhausted).toBe(true);
  });

  it('records refund reason and post-refund spent count for telemetry', () => {
    const b = new IterationBudget(3);
    b.consume();
    b.consume();
    b.refund('programmatic_only');
    b.refund('meta_tool_only');
    const events = b.refunds();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ reason: 'programmatic_only', usedAfter: 1 });
    expect(events[1]).toEqual({ reason: 'meta_tool_only', usedAfter: 0 });
  });

  it('total=0 budget is immediately exhausted and refunds are no-ops', () => {
    const b = new IterationBudget(0);
    expect(b.exhausted).toBe(true);
    expect(b.consume()).toBe(0);
    expect(b.refund('meta_tool_only')).toBe(false);
  });
});

describe('resolveLoopHardeningEnabled', () => {
  const original = process.env.HARNESS_LOOP_HARDENING;
  afterEach(() => {
    if (original === undefined) delete process.env.HARNESS_LOOP_HARDENING;
    else process.env.HARNESS_LOOP_HARDENING = original;
  });

  it('returns false by default (env unset)', () => {
    delete process.env.HARNESS_LOOP_HARDENING;
    expect(resolveLoopHardeningEnabled()).toBe(false);
  });

  it.each(['1', 'on', 'true', 'TRUE', 'On'])('returns true for env=%s', (val) => {
    process.env.HARNESS_LOOP_HARDENING = val;
    expect(resolveLoopHardeningEnabled()).toBe(true);
  });

  it.each(['0', 'off', 'false', '', 'no'])('returns false for env=%s', (val) => {
    process.env.HARNESS_LOOP_HARDENING = val;
    expect(resolveLoopHardeningEnabled()).toBe(false);
  });
});
