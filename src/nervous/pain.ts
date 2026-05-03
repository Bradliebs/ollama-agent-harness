// Nervous System — Pain signal engine.
//
// Extracts pain signals from nervous signals and calculates pain
// multipliers that reduce reward contribution for affected routes.

import type { NervousSignal, SignalSeverity } from './signals';

export interface PainSignal {
  painType: string;
  severity: SignalSeverity;
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
  reason: string;
  confidence: number;
  multiplier: number;
}

const PAIN_MULTIPLIERS: Record<SignalSeverity, number> = {
  info: 0.95,
  low: 0.85,
  medium: 0.65,
  high: 0.35,
  critical: 0.0,
};

const PAIN_SIGNAL_TYPES = new Set([
  'TOOL_ERROR',
  'REPEATED_FAILURE',
  'VERIFIER_FAIL',
  'AGENT_LOOP',
  'AGENT_STALL',
  'COST_SPIKE',
  'ROUTE_FAILURE',
  'USER_CORRECTION',
  'MEMORY_CONFLICT',
  'SAFETY_RISK',
  'PRIVACY_RISK',
]);

// Safety signal types that should be REWARDED when they correctly block
const SAFETY_REWARD_TYPES = new Set([
  'IRREVERSIBLE_ACTION',
  'DRY_RUN_REQUIRED',
  'CONFIRMATION_REQUIRED',
]);

export function extractPainSignals(signals: NervousSignal[], routeNodeIds: string[] = [], routeEdgeIds: string[] = []): PainSignal[] {
  const painSignals: PainSignal[] = [];

  for (const signal of signals) {
    if (!PAIN_SIGNAL_TYPES.has(signal.type)) continue;

    const toolName = signal.metadata?.toolName as string | undefined;
    const affectedNodes = toolName ? [`tool.${toolName}`] : routeNodeIds.slice(0, 5);
    const affectedEdges = routeEdgeIds.slice(0, 5);

    painSignals.push({
      painType: signal.type,
      severity: signal.severity,
      affectedNodeIds: affectedNodes,
      affectedEdgeIds: affectedEdges,
      reason: signal.message,
      confidence: signal.confidence,
      multiplier: PAIN_MULTIPLIERS[signal.severity],
    });
  }

  return painSignals;
}

/**
 * Calculate the aggregate pain multiplier for a route.
 * Returns a value between 0.0 (total pain) and 1.0 (no pain).
 */
export function aggregatePainMultiplier(painSignals: PainSignal[]): number {
  if (painSignals.length === 0) return 1.0;
  // Use the minimum multiplier (most severe pain wins)
  return Math.max(0, Math.min(...painSignals.map((p) => p.multiplier)));
}

/**
 * Determine if a safety signal should generate a POSITIVE reward
 * (the safety system correctly detected and blocked a risk).
 */
export function isSafetyRewardSignal(signal: NervousSignal): boolean {
  return SAFETY_REWARD_TYPES.has(signal.type);
}
