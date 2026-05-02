// Mycelial Context Router — heuristic verifier adapter
//
// v1 verifier that produces a coarse 0–1 score from cheap signals
// available without re-running tests or external checks. The router
// uses this score as a fallback when no domain-specific verifier
// (tests, lint, schema check, etc.) is connected.

import type { ContextPackage } from './contextPackage';

export interface VerifierInput {
  /** The final assistant response text. */
  response: string;
  /** The context package the harness ran with. */
  contextPackage: ContextPackage;
  /** Number of tool calls the harness made during the run. */
  toolCallCount?: number;
  /** Successful tool calls during the run. */
  toolSuccessCount?: number;
  /** Did the harness throw / abort? */
  errored?: boolean;
  /** Did the harness explicitly refuse / block (safety stop)? */
  refused?: boolean;
  /**
   * Optional real-verifier signals from the harness (output validation
   * profile result, test runner, lint, schema check). When provided,
   * they replace the heuristic for that component instead of the score
   * being inferred from response shape alone.
   */
  realSignals?: {
    /** Output validation profile result: 'pass' | 'warn' | 'fail'. */
    outputValidationStatus?: 'pass' | 'warn' | 'fail';
    /** Output validation score 0–1. */
    outputValidationScore?: number;
    /** Number of failing test cases (if a test runner ran). */
    testFailures?: number;
    /** Number of passing test cases. */
    testPasses?: number;
    /** Lint error count (0 = clean). */
    lintErrors?: number;
    /** Schema check passed? */
    schemaCheckPass?: boolean;
    /**
     * Per-tool success ratio for high-cost / failure-prone tools (web_fetch,
     * pdf extraction, etc.). When provided, the worst ratio drags down the
     * tool_reliability component so a chat that "succeeded" overall but had
     * silent web/pdf failures is still penalised.
     */
    toolSuccessRatios?: Record<string, number>;
  };
}

export interface VerifierResult {
  score: number;            // 0–1
  components: Record<string, number>;
  notes: string[];
  /** Names of verifier nodes that conceptually applied. */
  appliedVerifiers: string[];
  /** True if the verifier judged the run actively unsafe / required block. */
  failedHardCheck: boolean;
}

const HARD_BLOCK_TERMS = [
  'irreversible', 'production', 'wipe ', 'rm -rf', 'transfer funds',
  'execute trade', 'place order', 'delete database',
];

export function heuristicVerifier(input: VerifierInput): VerifierResult {
  const { response, contextPackage, toolCallCount = 0, toolSuccessCount = 0, errored, refused, realSignals } = input;
  const notes: string[] = [];
  const components: Record<string, number> = {};
  const appliedVerifiersSet = new Set<string>(contextPackage.selected_verifiers.map((v) => v.id));

  // 1. Task completion: did we produce a non-trivial response and not error?
  let taskCompletion = 0.5;
  if (errored) {
    taskCompletion = 0.1;
    notes.push('Run errored.');
  } else if (response.trim().length < 10) {
    taskCompletion = 0.2;
    notes.push('Response is very short.');
  } else if (response.trim().length > 60) {
    taskCompletion = 0.8;
  }
  // Real test signals override the heuristic for task_completion when present.
  if (realSignals?.testPasses !== undefined || realSignals?.testFailures !== undefined) {
    const passes = realSignals.testPasses ?? 0;
    const failures = realSignals.testFailures ?? 0;
    const total = passes + failures;
    if (total > 0) {
      taskCompletion = passes / total;
      notes.push(`Test runner: ${passes}/${total} passed.`);
      appliedVerifiersSet.add('verifier.code_test_check');
    }
  }
  components.task_completion = taskCompletion;

  // 2. Tool reliability: ratio of successful tool calls.
  if (toolCallCount > 0) {
    components.tool_reliability = toolSuccessCount / toolCallCount;
    if (components.tool_reliability < 0.5) {
      notes.push(`Tool reliability low: ${toolSuccessCount}/${toolCallCount}.`);
    }
  } else {
    components.tool_reliability = 0.5;
  }
  // Per-tool ratios: drag tool_reliability down to the worst-performing
  // failure-prone tool. This catches silent web_fetch / pdf_* failures that
  // an aggregate ratio would dilute.
  if (realSignals?.toolSuccessRatios) {
    const ratios = Object.entries(realSignals.toolSuccessRatios);
    if (ratios.length > 0) {
      const worst = ratios.reduce((min, [, r]) => Math.min(min, r), 1);
      const worstName = ratios.reduce((acc, [name, r]) => r < acc.r ? { name, r } : acc, { name: '', r: 1 });
      components.tool_reliability = Math.min(components.tool_reliability, worst);
      if (worst < 0.5 && worstName.name) {
        notes.push(`Tool '${worstName.name}' reliability ${(worst * 100).toFixed(0)}% — pulled tool_reliability down.`);
      }
    }
  }

  // 3. Safety check: high-risk task that wasn't refused / didn't dry-run is suspicious.
  let safety = 1;
  let failedHardCheck = false;
  if (contextPackage.high_risk && !refused && !contextPackage.dry_run) {
    const responseLower = response.toLowerCase();
    const hitHardTerm = HARD_BLOCK_TERMS.some((term) => responseLower.includes(term));
    if (hitHardTerm) {
      safety = 0.1;
      failedHardCheck = true;
      notes.push('High-risk task: response references irreversible action without dry-run / refusal.');
    } else {
      safety = 0.7;
      notes.push('High-risk task ran without explicit dry-run; partial credit only.');
    }
  } else if (refused && contextPackage.high_risk) {
    // Refusing a high-risk action is a *good* outcome for safety routes.
    safety = 1;
    notes.push('High-risk request was refused / blocked — safety route succeeded.');
  }
  components.safety = safety;

  // 4. Verifier coverage: did the route include verifier nodes?
  // If a real output-validation profile ran, fold its score in directly
  // and treat coverage as confirmed.
  if (realSignals?.outputValidationScore !== undefined) {
    components.verifier_coverage = clamp(realSignals.outputValidationScore);
    notes.push(`Output validation: ${realSignals.outputValidationStatus ?? 'unknown'} (score ${realSignals.outputValidationScore.toFixed(2)}).`);
    appliedVerifiersSet.add('verifier.task_completion');
    if (realSignals.outputValidationStatus === 'fail') failedHardCheck = true;
  } else {
    components.verifier_coverage = contextPackage.selected_verifiers.length > 0 ? 0.8 : 0.4;
  }

  // Lint errors and schema check act as small adjustments to verifier_coverage.
  if (realSignals?.lintErrors !== undefined) {
    const lintScore = realSignals.lintErrors === 0 ? 1 : 1 / (1 + realSignals.lintErrors);
    components.verifier_coverage = (components.verifier_coverage + lintScore) / 2;
    appliedVerifiersSet.add('verifier.code_test_check');
    if (realSignals.lintErrors > 0) notes.push(`${realSignals.lintErrors} lint error(s).`);
  }
  if (realSignals?.schemaCheckPass === false) {
    components.verifier_coverage = Math.min(components.verifier_coverage, 0.3);
    appliedVerifiersSet.add('verifier.schema_check');
    notes.push('Schema check failed.');
  } else if (realSignals?.schemaCheckPass === true) {
    appliedVerifiersSet.add('verifier.schema_check');
  }

  // 5. Constraint coverage: did the route include any selected_constraints/safety/preferences?
  const constraintCount = contextPackage.selected_constraints.length
    + contextPackage.selected_safety.length
    + contextPackage.selected_preferences.length;
  components.constraint_coverage = constraintCount > 0 ? 0.8 : 0.5;

  // Weighted blend.
  const score = clamp(
      0.30 * components.task_completion
    + 0.20 * components.tool_reliability
    + 0.25 * components.safety
    + 0.15 * components.verifier_coverage
    + 0.10 * components.constraint_coverage,
  );

  return { score, components, notes, appliedVerifiers: Array.from(appliedVerifiersSet), failedHardCheck };
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
