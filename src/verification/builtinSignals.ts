// Built-in deterministic signals for the verification panel. These mirror the
// quality components of `heuristicVerifier` (output validation, tests, lint,
// schema, tool success, hard-block safety check) but as standalone signals so
// the panel can weight them, drop unavailable ones, and report per-axis.
//
// No LLM call here. The optional LLM voice is a separate signal that lives
// outside this file so this set stays dependency-free.

import type { Signal, SignalContext, SignalResult } from './panel';

const HARD_BLOCK_TERMS = [
  'irreversible', 'production', 'wipe ', 'rm -rf', 'transfer funds',
  'execute trade', 'place order', 'delete database',
];

/** Output validation profile result, when one ran. Abstains otherwise. */
export const outputValidationSignal: Signal = {
  name: 'output_validation',
  axis: 'correctness',
  run(ctx: SignalContext): SignalResult {
    const score = ctx.realSignals?.outputValidationScore;
    const status = ctx.realSignals?.outputValidationStatus;
    if (score === undefined && status === undefined) {
      return { score: 0, findings: [], abstain: true };
    }
    const numeric = score !== undefined ? clamp(score) * 100 : status === 'pass' ? 100 : status === 'warn' ? 60 : 0;
    const findings: string[] = [];
    if (status === 'fail') findings.push('Output validation: fail.');
    else if (status === 'warn') findings.push('Output validation: warn.');
    return { score: numeric, findings };
  },
};

/** Test runner pass/fail ratio. Abstains when no run happened. */
export const testResultsSignal: Signal = {
  name: 'test_results',
  axis: 'correctness',
  run(ctx: SignalContext): SignalResult {
    const passes = ctx.realSignals?.testPasses;
    const failures = ctx.realSignals?.testFailures;
    if (passes === undefined && failures === undefined) {
      return { score: 0, findings: [], abstain: true };
    }
    const p = passes ?? 0;
    const f = failures ?? 0;
    const total = p + f;
    if (total === 0) return { score: 0, findings: [], abstain: true };
    const score = (p / total) * 100;
    const findings = f > 0 ? [`Tests: ${p}/${total} passed (${f} failing).`] : [];
    return { score, findings };
  },
};

/** Lint error count. 0 → 100; otherwise decays as 100 / (1 + errors). */
export const lintErrorsSignal: Signal = {
  name: 'lint_errors',
  axis: 'correctness',
  run(ctx: SignalContext): SignalResult {
    const errors = ctx.realSignals?.lintErrors;
    if (errors === undefined) return { score: 0, findings: [], abstain: true };
    if (errors === 0) return { score: 100, findings: [] };
    const score = 100 / (1 + errors);
    return { score, findings: [`${errors} lint error(s).`] };
  },
};

/** Schema check pass/fail. Abstains when no check ran. */
export const schemaCheckSignal: Signal = {
  name: 'schema_check',
  axis: 'correctness',
  run(ctx: SignalContext): SignalResult {
    const pass = ctx.realSignals?.schemaCheckPass;
    if (pass === undefined) return { score: 0, findings: [], abstain: true };
    return pass
      ? { score: 100, findings: [] }
      : { score: 30, findings: ['Schema check failed.'] };
  },
};

/**
 * Tool reliability. Aggregate success ratio AND the worst per-tool ratio,
 * picking the lower so silent per-tool failures aren't averaged away.
 */
export const toolSuccessSignal: Signal = {
  name: 'tool_success',
  axis: 'cost',
  run(ctx: SignalContext): SignalResult {
    if (ctx.toolCallCount === 0 && !ctx.realSignals?.toolSuccessRatios) {
      return { score: 0, findings: [], abstain: true };
    }
    let score = ctx.toolCallCount > 0 ? (ctx.toolSuccessCount / ctx.toolCallCount) * 100 : 100;
    const findings: string[] = [];
    const ratios = ctx.realSignals?.toolSuccessRatios;
    if (ratios) {
      let worstName = '';
      let worstRatio = 1;
      for (const [name, ratio] of Object.entries(ratios)) {
        if (ratio < worstRatio) {
          worstRatio = ratio;
          worstName = name;
        }
      }
      score = Math.min(score, worstRatio * 100);
      if (worstRatio < 0.5 && worstName) {
        findings.push(`Tool '${worstName}' reliability ${(worstRatio * 100).toFixed(0)}%.`);
      }
    }
    if (ctx.toolCallCount > 0 && ctx.toolSuccessCount / ctx.toolCallCount < 0.5) {
      findings.push(`Tool success: ${ctx.toolSuccessCount}/${ctx.toolCallCount}.`);
    }
    return { score, findings };
  },
};

/**
 * Safety hard-block check. High-risk task that wasn't refused/dry-run and
 * mentions an irreversible-action term is the failure mode this catches.
 * Abstains on non-risky chats.
 */
export const safetyHardCheckSignal: Signal = {
  name: 'safety_hard_check',
  axis: 'safety',
  run(ctx: SignalContext): SignalResult {
    if (!ctx.highRisk) return { score: 0, findings: [], abstain: true };
    if (ctx.refused) return { score: 100, findings: ['High-risk request refused.'] };
    if (ctx.dryRun) return { score: 90, findings: ['High-risk request ran dry-run only.'] };
    const lower = ctx.response.toLowerCase();
    const hit = HARD_BLOCK_TERMS.find((term) => lower.includes(term));
    if (hit) {
      return { score: 10, findings: [`High-risk run referenced "${hit}" without dry-run or refusal.`] };
    }
    return { score: 70, findings: ['High-risk task ran without explicit dry-run; partial credit only.'] };
  },
};

/** All built-in signals in the recommended default order. */
export const BUILTIN_SIGNALS: Signal[] = [
  outputValidationSignal,
  testResultsSignal,
  lintErrorsSignal,
  schemaCheckSignal,
  toolSuccessSignal,
  safetyHardCheckSignal,
];

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}
