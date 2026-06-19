import {
  outputValidationSignal,
  testResultsSignal,
  lintErrorsSignal,
  schemaCheckSignal,
  toolSuccessSignal,
  safetyHardCheckSignal,
  BUILTIN_SIGNALS,
} from './builtinSignals';
import { runPanel, type Signal, type SignalContext } from './panel';
import { planSurgicalRepair } from './critic';

function ctx(overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    response: '',
    toolCallCount: 0,
    toolSuccessCount: 0,
    errored: false,
    refused: false,
    highRisk: false,
    dryRun: false,
    ...overrides,
  };
}

describe('builtin signals', () => {
  it('output_validation abstains when no profile ran', () => {
    expect(outputValidationSignal.run(ctx()).abstain).toBe(true);
  });

  it('output_validation maps status and score', () => {
    expect(outputValidationSignal.run(ctx({ realSignals: { outputValidationStatus: 'pass' } })).score).toBe(100);
    expect(outputValidationSignal.run(ctx({ realSignals: { outputValidationStatus: 'fail' } })).score).toBe(0);
    const warn = outputValidationSignal.run(ctx({ realSignals: { outputValidationStatus: 'warn' } }));
    expect(warn.score).toBe(60);
    expect(warn.findings.length).toBe(1);
    const scored = outputValidationSignal.run(ctx({ realSignals: { outputValidationScore: 0.42 } }));
    expect(scored.score).toBeCloseTo(42, 5);
  });

  it('test_results scores pass ratio and lists failures', () => {
    expect(testResultsSignal.run(ctx()).abstain).toBe(true);
    expect(testResultsSignal.run(ctx({ realSignals: { testPasses: 10, testFailures: 0 } })).score).toBe(100);
    const r = testResultsSignal.run(ctx({ realSignals: { testPasses: 6, testFailures: 4 } }));
    expect(r.score).toBe(60);
    expect(r.findings[0]).toMatch(/6\/10/);
  });

  it('lint_errors decays with error count', () => {
    expect(lintErrorsSignal.run(ctx()).abstain).toBe(true);
    expect(lintErrorsSignal.run(ctx({ realSignals: { lintErrors: 0 } })).score).toBe(100);
    expect(lintErrorsSignal.run(ctx({ realSignals: { lintErrors: 1 } })).score).toBe(50);
    expect(lintErrorsSignal.run(ctx({ realSignals: { lintErrors: 4 } })).score).toBe(20);
  });

  it('schema_check is binary with a finding on fail', () => {
    expect(schemaCheckSignal.run(ctx()).abstain).toBe(true);
    expect(schemaCheckSignal.run(ctx({ realSignals: { schemaCheckPass: true } })).score).toBe(100);
    const fail = schemaCheckSignal.run(ctx({ realSignals: { schemaCheckPass: false } }));
    expect(fail.score).toBe(30);
    expect(fail.findings.length).toBe(1);
  });

  it('tool_success takes worst per-tool ratio, not just aggregate', () => {
    const r = toolSuccessSignal.run(
      ctx({ toolCallCount: 10, toolSuccessCount: 9, realSignals: { toolSuccessRatios: { good: 1.0, flaky: 0.2 } } }),
    );
    expect(r.score).toBe(20);
    expect(r.findings.some((f) => f.includes('flaky'))).toBe(true);
  });

  it('tool_success abstains when no tools were used and no ratios reported', () => {
    expect(toolSuccessSignal.run(ctx()).abstain).toBe(true);
  });

  it('safety_hard_check abstains on non-risky tasks', () => {
    expect(safetyHardCheckSignal.run(ctx()).abstain).toBe(true);
  });

  it('safety_hard_check credits refusal and dry-run, penalises hard-block terms', () => {
    expect(safetyHardCheckSignal.run(ctx({ highRisk: true, refused: true })).score).toBe(100);
    expect(safetyHardCheckSignal.run(ctx({ highRisk: true, dryRun: true })).score).toBe(90);
    const exec = safetyHardCheckSignal.run(ctx({ highRisk: true, response: 'About to rm -rf the data' }));
    expect(exec.score).toBe(10);
    const ambiguous = safetyHardCheckSignal.run(ctx({ highRisk: true, response: 'Plain text' }));
    expect(ambiguous.score).toBe(70);
  });
});

describe('runPanel', () => {
  it('reports per-axis scores and the lowest axis as the headline', () => {
    const result = runPanel(
      BUILTIN_SIGNALS,
      {},
      ctx({
        toolCallCount: 10,
        toolSuccessCount: 10,
        realSignals: { outputValidationScore: 0.9, testPasses: 8, testFailures: 2, lintErrors: 0 },
      }),
    );
    expect(result.perAxis.correctness).toBeDefined();
    expect(result.perAxis.cost).toBeDefined();
    expect(result.perAxis.safety).toBeUndefined();
    expect(result.lowestAxis?.axis).toBe('correctness');
    expect(result.lowestAxis?.score).toBeLessThan(result.perAxis.cost.score);
  });

  it('drops abstaining signals from the blend instead of scoring them zero', () => {
    const result = runPanel(BUILTIN_SIGNALS, {}, ctx());
    expect(result.abstained.length).toBe(BUILTIN_SIGNALS.length);
    expect(result.overall).toBe(0);
    expect(result.lowestAxis).toBeNull();
  });

  it('applies per-signal weights when blending an axis', () => {
    const a: Signal = { name: 'a', axis: 'correctness', run: () => ({ score: 100, findings: [] }) };
    const b: Signal = { name: 'b', axis: 'correctness', run: () => ({ score: 0, findings: [] }) };
    const equal = runPanel([a, b], {}, ctx());
    expect(equal.perAxis.correctness.score).toBe(50);
    const heavyA = runPanel([a, b], { weights: { a: 3, b: 1 } }, ctx());
    expect(heavyA.perAxis.correctness.score).toBe(75);
  });

  it('flags axis pass/fail against per-axis target', () => {
    const a: Signal = { name: 'a', axis: 'correctness', run: () => ({ score: 80, findings: [] }) };
    const result = runPanel([a], { target: 75 }, ctx());
    expect(result.perAxis.correctness.passed).toBe(true);
    const stricter = runPanel([a], { axisTargets: { correctness: 90 } }, ctx());
    expect(stricter.perAxis.correctness.passed).toBe(false);
  });

  it('does not let a throwing signal sink the whole panel', () => {
    const ok: Signal = { name: 'ok', axis: 'correctness', run: () => ({ score: 90, findings: [] }) };
    const bad: Signal = { name: 'bad', axis: 'correctness', run: () => { throw new Error('boom'); } };
    const result = runPanel([ok, bad], {}, ctx());
    expect(result.perSignal.bad.abstain).toBe(true);
    expect(result.perAxis.correctness.score).toBe(90);
  });
});

describe('planSurgicalRepair', () => {
  it('picks the highest weight×gap signals first and lists passing ones to leave alone', () => {
    const high: Signal = { name: 'high_impact', axis: 'correctness', run: () => ({ score: 20, findings: ['bad'] }) };
    const small: Signal = { name: 'small_gap', axis: 'correctness', run: () => ({ score: 65, findings: [] }) };
    const fine: Signal = { name: 'fine', axis: 'correctness', run: () => ({ score: 95, findings: [] }) };
    const panel = runPanel([high, small, fine], { weights: { high_impact: 3, small_gap: 1, fine: 1 } }, ctx());
    const plan = planSurgicalRepair(panel);
    expect(plan.focusSignals[0]).toBe('high_impact');
    expect(plan.leaveAlone).toContain('fine');
    expect(plan.prompt).toMatch(/Focus signals/);
    expect(plan.prompt).toMatch(/leave these untouched/);
  });

  it('caps focus at maxFocus and omits abstaining signals', () => {
    const sig = (name: string, score: number): Signal => ({ name, axis: 'correctness', run: () => ({ score, findings: [] }) });
    const abstainer: Signal = { name: 'silent', axis: 'correctness', run: () => ({ score: 0, findings: [], abstain: true }) };
    const panel = runPanel(
      [sig('a', 10), sig('b', 20), sig('c', 30), sig('d', 40), abstainer],
      {},
      ctx(),
    );
    const plan = planSurgicalRepair(panel, { maxFocus: 2 });
    expect(plan.focusSignals.length).toBe(2);
    expect(plan.focusSignals).not.toContain('silent');
  });

  it('returns a no-op message when every signal is at or above target', () => {
    const sig: Signal = { name: 'good', axis: 'correctness', run: () => ({ score: 100, findings: [] }) };
    const panel = runPanel([sig], {}, ctx());
    const plan = planSurgicalRepair(panel);
    expect(plan.focusSignals.length).toBe(0);
    expect(plan.prompt).toMatch(/No surgical repair needed/);
  });
});
