import { CostTracker } from './costTracker';
import type { CostSummary, TokenRate } from './costTracker';

describe('CostTracker', () => {
  it('tracks turns and computes total cost for a cloud model', () => {
    const tracker = new CostTracker('gpt-4o');
    tracker.recordTurn(1, 1000, 500);
    tracker.recordTurn(2, 800, 300);

    const summary = tracker.summarize();
    expect(summary.totalInputTokens).toBe(1800);
    expect(summary.totalOutputTokens).toBe(800);
    // gpt-4o: input $0.0025/1K, output $0.01/1K
    // Turn 1: (1000/1000)*0.0025 + (500/1000)*0.01 = 0.0025 + 0.005 = 0.0075
    // Turn 2: (800/1000)*0.0025 + (300/1000)*0.01 = 0.002 + 0.003 = 0.005
    // Total: 0.0125
    expect(summary.totalEstimatedCostUsd).toBeCloseTo(0.0125, 5);
    expect(summary.budgetExceeded).toBe(false);
    expect(summary.turns).toHaveLength(2);
  });

  it('returns zero cost for local models', () => {
    const tracker = new CostTracker('qwen2.5-coder:14b');
    tracker.recordTurn(1, 5000, 2000);
    expect(tracker.totalCost()).toBe(0);
  });

  it('detects budget exceeded', () => {
    const tracker = new CostTracker('gpt-4o', { budgetUsd: 0.005 });
    const exceeded1 = tracker.recordTurn(1, 1000, 500);
    // 0.0075 > 0.005 → exceeded
    expect(exceeded1).toBe(true);
    expect(tracker.summarize().budgetExceeded).toBe(true);
  });

  it('does not flag budget when under limit', () => {
    const tracker = new CostTracker('gpt-4o', { budgetUsd: 1.0 });
    const exceeded = tracker.recordTurn(1, 100, 50);
    expect(exceeded).toBe(false);
    expect(tracker.summarize().budgetExceeded).toBe(false);
  });

  it('computes costPerSuccess', () => {
    const tracker = new CostTracker('gpt-4o');
    tracker.recordTurn(1, 1000, 500);
    const summary = tracker.summarize(3);
    expect(summary.costPerSuccess).toBeCloseTo(0.0075 / 3, 5);
  });

  it('uses custom rates when provided', () => {
    const tracker = new CostTracker('custom-model', {
      rates: { 'custom-model': { input: 0.001, output: 0.002 } },
    });
    tracker.recordTurn(1, 2000, 1000);
    // (2000/1000)*0.001 + (1000/1000)*0.002 = 0.002 + 0.002 = 0.004
    expect(tracker.totalCost()).toBeCloseTo(0.004, 6);
  });

  it('defaults unknown models to zero cost', () => {
    const tracker = new CostTracker('some-unknown-model');
    tracker.recordTurn(1, 10000, 5000);
    expect(tracker.totalCost()).toBe(0);
  });

  it('registerRate makes new rates available', () => {
    CostTracker.registerRate('test-model', { input: 0.01, output: 0.02 });
    const tracker = new CostTracker('test-model');
    tracker.recordTurn(1, 1000, 1000);
    // (1000/1000)*0.01 + (1000/1000)*0.02 = 0.01 + 0.02 = 0.03
    expect(tracker.totalCost()).toBeCloseTo(0.03, 6);
  });

  it('getAllRates returns a copy of default rates', () => {
    const rates = CostTracker.getAllRates();
    expect(rates['gpt-4o']).toBeDefined();
    expect(rates['gpt-4o'].input).toBe(0.0025);
  });
});
