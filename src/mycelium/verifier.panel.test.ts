import { heuristicVerifier, type VerifierInput } from './verifier';
import { MyceliumGraph } from './graph';
import { MycelialContextRouter } from './router';
import { seedGenericGraph } from './seeds';
import { BUILTIN_SIGNALS } from '../verification/builtinSignals';

function makePackage() {
  const graph = new MyceliumGraph();
  seedGenericGraph(graph);
  const router = new MycelialContextRouter('/tmp', graph);
  return router.routeQueryRich('Implement a JSON parser').contextPackage;
}

describe('heuristicVerifier opt-in panel', () => {
  it('produces a byte-identical VerifierResult when no panel is supplied', () => {
    const pkg = makePackage();
    const input: VerifierInput = {
      response: 'Here is the implementation.',
      contextPackage: pkg,
      toolCallCount: 4,
      toolSuccessCount: 3,
      realSignals: {
        outputValidationScore: 0.9,
        outputValidationStatus: 'pass',
        testPasses: 8,
        testFailures: 2,
        lintErrors: 1,
        schemaCheckPass: true,
        toolSuccessRatios: { web_fetch: 0.6 },
      },
    };
    const before = heuristicVerifier(input);
    const after = heuristicVerifier(input);
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty('panelResult');
  });

  it('attaches panelResult without altering score or components when panel is supplied', () => {
    const pkg = makePackage();
    const base: VerifierInput = {
      response: 'Here is the implementation.',
      contextPackage: pkg,
      toolCallCount: 4,
      toolSuccessCount: 3,
      realSignals: {
        outputValidationScore: 0.9,
        outputValidationStatus: 'pass',
        testPasses: 8,
        testFailures: 2,
        lintErrors: 1,
        schemaCheckPass: true,
      },
    };
    const legacy = heuristicVerifier(base);
    const panelled = heuristicVerifier({ ...base, panel: { signals: BUILTIN_SIGNALS } });
    expect(panelled.score).toBe(legacy.score);
    expect(panelled.components).toEqual(legacy.components);
    expect(panelled.notes).toEqual(legacy.notes);
    expect(panelled.appliedVerifiers).toEqual(legacy.appliedVerifiers);
    expect(panelled.failedHardCheck).toBe(legacy.failedHardCheck);
    expect(panelled.panelResult).toBeDefined();
    expect(panelled.panelResult?.perAxis.correctness).toBeDefined();
    expect(panelled.panelResult?.lowestAxis).not.toBeNull();
  });

  it('panel sees high-risk and dry-run via the context package', () => {
    const pkg = makePackage();
    pkg.high_risk = true;
    pkg.dry_run = true;
    const result = heuristicVerifier({
      response: 'About to wipe nothing; dry-run only.',
      contextPackage: pkg,
      panel: { signals: BUILTIN_SIGNALS },
    });
    expect(result.panelResult?.perAxis.safety).toBeDefined();
    expect(result.panelResult?.perAxis.safety.score).toBeGreaterThanOrEqual(70);
  });

  it('panel config (weights, target overrides) flow through to the result', () => {
    const pkg = makePackage();
    const result = heuristicVerifier({
      response: 'OK.',
      contextPackage: pkg,
      realSignals: { outputValidationScore: 0.5, testPasses: 10, testFailures: 0, lintErrors: 0 },
      panel: {
        signals: BUILTIN_SIGNALS,
        config: { weights: { output_validation: 10 }, axisTargets: { correctness: 90 } },
      },
    });
    const correctness = result.panelResult?.perAxis.correctness;
    expect(correctness).toBeDefined();
    expect(correctness?.target).toBe(90);
    // output_validation is 50 and weighted 10x; the rest are 100 weighted 1x each.
    // Expect the blend to land closer to 50 than to 100.
    expect(correctness?.score).toBeLessThan(70);
  });
});
