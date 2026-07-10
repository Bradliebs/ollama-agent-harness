// Execution-grounded verification kernel — task-kind routing.
//
// The harness's trust moat is replacing LLM-judged "scores" with deterministic
// proof. The first step is honest routing: given a request, decide WHAT KIND of
// task it is, and therefore what counts as proof that it actually worked.
//
// This module is pure (no I/O) so it is trivially testable. It does NOT run any
// checks itself — it maps a request to a verification strategy that the goal
// loop's existing runners (command / test_suite / file_exists / model_judge in
// verification.ts) can execute. It is deliberately honest about its own limits:
// `factual` and `unknown` tasks cannot yet be proven by execution, so their
// strategy is flagged `executionGrounded: false` rather than pretending a model
// rubric is proof.
//
// Naming note: a separate `TaskKind` ('code' | 'research' | 'external') already
// exists in services/goalExpander.ts for plan-task categorization. This taxonomy
// is about verification proof, so it uses `VerificationTaskKind` to avoid clashing.

import type { GoalCheck, GoalCheckKind } from './types';

/** What kind of task a request represents, for the purpose of choosing proof. */
export type VerificationTaskKind = 'code' | 'edit' | 'factual' | 'data' | 'unknown';

/** How a given task kind is proven to have worked. */
export interface VerificationStrategy {
  taskKind: VerificationTaskKind;
  /**
   * True when this kind can be proven by deterministic execution today.
   * False means the harness falls back to model judgement and must say so
   * rather than presenting a rubric score as proof.
   */
  executionGrounded: boolean;
  /** Goal check kinds that constitute valid proof for this task kind, best-first. */
  proofChecks: GoalCheckKind[];
  /** One-line, user-facing description of what counts as proof for this kind. */
  proofLabel: string;
}

/**
 * Per-kind strategy overrides. A consumer (e.g. a project with stricter proof
 * rules, or one that has added citation checks that make `factual` tasks
 * execution-grounded) can replace the built-in strategy for specific kinds
 * without editing this kernel. Kinds left unset fall back to the defaults.
 */
export type VerificationStrategyOverrides = Partial<Record<VerificationTaskKind, VerificationStrategy>>;

// Signal sets per task kind. Lower-cased substring matches against the request.
// Kept conservative and transparent; ambiguity resolves to 'unknown' rather than
// guessing, which is the honest default for a trust-first system.
const SIGNALS: Record<Exclude<VerificationTaskKind, 'unknown'>, readonly string[]> = {
  // Producing or changing executable behaviour that a test/build can verify.
  code: [
    'implement', 'write a function', 'write code', 'add a feature', 'add an endpoint',
    'add a test', 'unit test', 'refactor', 'compile', 'build the', 'create a script',
    'fix the bug', 'debug', 'function', 'class ', 'module', 'api endpoint', 'algorithm',
  ],
  // Small, localized changes verifiable by lint/format/diff rather than a test suite.
  edit: [
    'edit ', 'rename', 'modify', 'tweak', 'adjust', 'fix typo', 'reword', 'rephrase',
    'reformat', 'format the', 'update the wording', 'change the text', 'correct the',
  ],
  // Producing or transforming data that assertions can check.
  data: [
    'dataset', 'csv', 'parse', 'extract data', 'scrape', 'spreadsheet', 'aggregate',
    'count rows', 'sum the', 'transform the data', 'clean the data', 'data file', 'records',
  ],
  // Answering a question, verifiable only by source citations (not yet execution-grounded).
  factual: [
    'what is', 'what are', 'who is', 'who was', 'when did', 'when was', 'where is',
    'explain', 'summarize', 'summarise', 'research', 'find out', 'tell me about',
    'how does', 'why does', 'why is', 'describe',
  ],
};

// Deterministic tiebreak when two kinds match the same number of signals.
const TIEBREAK_ORDER: readonly Exclude<VerificationTaskKind, 'unknown'>[] = [
  'data', 'code', 'edit', 'factual',
];

const STRATEGIES: Record<VerificationTaskKind, VerificationStrategy> = {
  code: {
    taskKind: 'code',
    executionGrounded: true,
    proofChecks: ['test_suite', 'command'],
    proofLabel: 'Tests pass and the build/command exits 0',
  },
  edit: {
    taskKind: 'edit',
    executionGrounded: true,
    proofChecks: ['command', 'file_exists'],
    proofLabel: 'Lint/format command exits 0 and the changed file exists',
  },
  data: {
    taskKind: 'data',
    executionGrounded: true,
    proofChecks: ['command', 'file_exists'],
    proofLabel: 'An assertion command exits 0 over the produced data',
  },
  factual: {
    taskKind: 'factual',
    executionGrounded: false,
    proofChecks: ['model_judge'],
    proofLabel: 'Source citations required — not yet deterministically verifiable',
  },
  unknown: {
    taskKind: 'unknown',
    executionGrounded: false,
    proofChecks: ['model_judge'],
    proofLabel: 'Task kind unknown — falls back to rubric judgement, not proof',
  },
};

/**
 * Classify a request into a verification task kind using transparent keyword
 * signals. Highest signal count wins; ties break by TIEBREAK_ORDER; no signals
 * yields 'unknown'. Pure and deterministic — no LLM call.
 */
export function classifyVerificationTaskKind(text: string): VerificationTaskKind {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return 'unknown';

  let best: Exclude<VerificationTaskKind, 'unknown'> | null = null;
  let bestCount = 0;
  for (const kind of TIEBREAK_ORDER) {
    let count = 0;
    for (const signal of SIGNALS[kind]) {
      if (haystack.includes(signal)) count++;
    }
    // Strictly greater so TIEBREAK_ORDER wins ties (it is iterated in priority order).
    if (count > bestCount) {
      bestCount = count;
      best = kind;
    }
  }
  return best ?? 'unknown';
}

/** Return the verification strategy for a task kind, applying any overrides. */
export function getVerificationStrategy(
  kind: VerificationTaskKind,
  overrides?: VerificationStrategyOverrides,
): VerificationStrategy {
  return overrides?.[kind] ?? STRATEGIES[kind];
}

/** Convenience: classify a request and return its verification strategy in one call. */
export function strategyForRequest(
  text: string,
  overrides?: VerificationStrategyOverrides,
): VerificationStrategy {
  return getVerificationStrategy(classifyVerificationTaskKind(text), overrides);
}

/** Whether a goal's verification is honest proof for what kind of task it is. */
export interface VerificationAdequacy {
  taskKind: VerificationTaskKind;
  executionGrounded: boolean;
  /** Distinct required-check kinds that count as deterministic proof for this task kind. */
  matchedProofChecks: GoalCheckKind[];
  /** True when completion would rest on at least one deterministic proof check. */
  hasDeterministicProof: boolean;
  /**
   * True when the goal's verification is honest for its kind:
   *   - execution-grounded kinds REQUIRE a deterministic proof check to be adequate;
   *   - non-grounded kinds (factual/unknown) are adequate-as-possible but can never be
   *     execution-grounded, so `adequate` stays true while `executionGrounded` is false.
   */
  adequate: boolean;
  reason: string;
}

/**
 * Decide whether a goal's verification checks are honest proof for the kind of
 * task its target describes. This is the moat's core check: an execution-grounded
 * task (code/edit/data) that has no required deterministic proof check can reach
 * "complete" while only *looking* done. Pure — does not run any checks.
 */
export function assessVerificationAdequacy(
  target: string,
  checks: readonly GoalCheck[],
  overrides?: VerificationStrategyOverrides,
): VerificationAdequacy {
  const strategy = strategyForRequest(target, overrides);
  const proof = new Set<GoalCheckKind>(strategy.proofChecks);
  const matchedProofChecks = [
    ...new Set(checks.filter((c) => c.required && proof.has(c.spec.kind)).map((c) => c.spec.kind)),
  ];

  if (strategy.executionGrounded) {
    const hasDeterministicProof = matchedProofChecks.length > 0;
    return {
      taskKind: strategy.taskKind,
      executionGrounded: true,
      matchedProofChecks,
      hasDeterministicProof,
      adequate: hasDeterministicProof,
      reason: hasDeterministicProof
        ? `Completion is backed by deterministic proof (${matchedProofChecks.join(', ')}).`
        : `Task looks like '${strategy.taskKind}' but has no required ${strategy.proofChecks.join('/')} check — completion would NOT be execution-grounded.`,
    };
  }

  return {
    taskKind: strategy.taskKind,
    executionGrounded: false,
    matchedProofChecks,
    hasDeterministicProof: false,
    adequate: true,
    reason: `Task kind '${strategy.taskKind}' cannot be deterministically verified yet; ${strategy.proofLabel.toLowerCase()}.`,
  };
}
