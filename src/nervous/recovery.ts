// Nervous System — Recovery controller.
//
// Manages recovery mode when the agent is stuck, failing repeatedly,
// or producing incorrect results. Provides structured recovery output.

import type { NervousRunState } from './reflexes';
import type { NervousSignal } from './signals';

export interface RecoveryPlan {
  reason: string;
  whatFailed: string[];
  lastKnownGoodState: string;
  safeNextAction: string;
  whatWasAvoided: string[];
  verifierRequired: boolean;
  reducedExploration: boolean;
}

export function buildRecoveryPlan(state: NervousRunState, signals: NervousSignal[]): RecoveryPlan {
  const failures = signals.filter((s) =>
    s.type === 'TOOL_ERROR' || s.type === 'REPEATED_FAILURE' || s.type === 'VERIFIER_FAIL' || s.type === 'AGENT_LOOP' || s.type === 'ROUTE_FAILURE',
  );

  const whatFailed = failures.map((s) => s.message);
  const toolErrors = Array.from(state.toolErrors.entries()).map(([tool, count]) => `${tool} (${count} errors)`);

  const reason = state.loopCount > 0
    ? `Agent loop detected (${state.loopCount} repeats)`
    : failures.length > 0
      ? `${failures.length} failure signal(s) detected`
      : 'Recovery triggered by nervous system';

  return {
    reason,
    whatFailed: [...whatFailed, ...toolErrors],
    lastKnownGoodState: 'Last successful tool call or user message',
    safeNextAction: determineSafeNextAction(state, failures),
    whatWasAvoided: state.forbiddenNodes.map((n) => `Excluded: ${n}`),
    verifierRequired: true,
    reducedExploration: true,
  };
}

function determineSafeNextAction(state: NervousRunState, failures: NervousSignal[]): string {
  const hasToolFailure = failures.some((s) => s.type === 'TOOL_ERROR' || s.type === 'REPEATED_FAILURE');
  const hasLoop = failures.some((s) => s.type === 'AGENT_LOOP');
  const hasVerifierFail = failures.some((s) => s.type === 'VERIFIER_FAIL');

  if (hasLoop) return 'Summarize current state and ask the user for clarification.';
  if (hasToolFailure) return 'Try an alternative tool or approach. Avoid the failed tool.';
  if (hasVerifierFail) return 'Review the output against the original request and correct.';
  return 'Take the smallest safe step toward the goal and verify.';
}

/**
 * Format a recovery plan as text for inclusion in the system prompt
 * or context package.
 */
export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const lines = [
    `⚠️ RECOVERY MODE`,
    `Reason: ${plan.reason}`,
    plan.whatFailed.length > 0 ? `Failed: ${plan.whatFailed.join('; ')}` : '',
    `Safe next action: ${plan.safeNextAction}`,
    plan.whatWasAvoided.length > 0 ? `Avoided: ${plan.whatWasAvoided.join('; ')}` : '',
    plan.verifierRequired ? 'Verification required before proceeding.' : '',
  ].filter(Boolean);
  return lines.join('\n');
}
