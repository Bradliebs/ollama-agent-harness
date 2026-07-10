// Tests for the HARNESS_SURGICAL_CRITIC=1 enhancement to the conductor's
// remediation branch. Default-off behaviour is covered by the existing
// taskConductor.test.ts ("inserts a remediation step when verification fails,
// then passes" implicitly proves the legacy intent still works).

import {
  runConductor,
  type ConductorEvent,
  type ConductorStep,
  type StepExecutor,
  type StepResult,
  type StepVerifier,
} from './taskConductor';
import type { VerificationResult } from './doneStateVerifier';

function step(id: number, over: Partial<ConductorStep> = {}): ConductorStep {
  return { id, intent: `step ${id}`, suggestedToolsets: [], verify: { kind: 'code' }, done: false, ...over };
}

function okResult(over: Partial<StepResult> = {}): StepResult {
  return { text: 'did it', toolCallSequence: [], toolCallCount: 0, toolSuccessCount: 0, fileChanged: true, missingTools: [], doneReason: 'completed', ...over };
}

function pass(): VerificationResult {
  return { domain: 'code', overall: 'pass', checks: [{ name: 'typecheck', domain: 'code', status: 'pass' }], timestamp: 'now' };
}

function fail(): VerificationResult {
  return {
    domain: 'code',
    overall: 'fail',
    checks: [
      { name: 'typecheck', domain: 'code', status: 'fail', detail: 'TS2322 type mismatch' },
      { name: 'lint', domain: 'code', status: 'pass' },
    ],
    timestamp: 'now',
  };
}

describe('taskConductor surgical critic gate', () => {
  const original = process.env.HARNESS_SURGICAL_CRITIC;
  afterEach(() => {
    if (original === undefined) delete process.env.HARNESS_SURGICAL_CRITIC;
    else process.env.HARNESS_SURGICAL_CRITIC = original;
  });

  async function runWithRemediation(): Promise<string | null> {
    const intents: string[] = [];
    let verifyCalls = 0;
    const verifier: StepVerifier = async () => {
      verifyCalls++;
      return verifyCalls === 1 ? fail() : pass();
    };
    const executor: StepExecutor = async (s) => {
      intents.push(s.intent);
      return okResult();
    };
    const events: ConductorEvent[] = [];
    await runConductor({
      task: 't',
      planner: async (task) => ({ task, steps: [step(1)] }),
      executor,
      verifier,
      onEvent: (e) => events.push(e),
    });
    // intents[0] is the original step; intents[1] is the spliced remediation.
    return intents[1] ?? null;
  }

  it('default (env unset) keeps the legacy generic remediation intent', async () => {
    delete process.env.HARNESS_SURGICAL_CRITIC;
    const remediationIntent = await runWithRemediation();
    expect(remediationIntent).toMatch(/Diagnose and fix it/);
    expect(remediationIntent).not.toMatch(/Surgical repair plan/);
  });

  it('with HARNESS_SURGICAL_CRITIC=1 swaps in a focused critic prompt', async () => {
    process.env.HARNESS_SURGICAL_CRITIC = '1';
    const remediationIntent = await runWithRemediation();
    expect(remediationIntent).toMatch(/Surgical repair plan/);
    expect(remediationIntent).toMatch(/typecheck/);
    expect(remediationIntent).toMatch(/TS2322 type mismatch/);
    // The passing check should appear in the leave-alone list.
    expect(remediationIntent).toMatch(/leave these untouched/);
    expect(remediationIntent).toMatch(/lint/);
  });

  it('off when env is set to any value other than "1"', async () => {
    process.env.HARNESS_SURGICAL_CRITIC = 'true';
    const remediationIntent = await runWithRemediation();
    expect(remediationIntent).toMatch(/Diagnose and fix it/);
  });
});
