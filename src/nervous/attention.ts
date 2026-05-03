// Nervous System — Attention controller.
//
// Calculates attention biases that influence Mycelium route selection.
// Biases change based on signals, task type, and run state.

import type { NervousSignal } from './signals';
import type { NervousRunState } from './reflexes';

export interface AttentionBiases {
  latestUserMessage: number;
  safetyNodes: number;
  verifierNodes: number;
  userPreferences: number;
  recentFailures: number;
  freshSources: number;
  lowCostRoutes: number;
  novelRoutes: number;
}

const DEFAULT_BIASES: AttentionBiases = {
  latestUserMessage: 1.0,
  safetyNodes: 0.8,
  verifierNodes: 0.6,
  userPreferences: 0.7,
  recentFailures: -0.4,
  freshSources: 0.4,
  lowCostRoutes: 0.3,
  novelRoutes: 0.2,
};

export function calculateAttentionBiases(signals: NervousSignal[], state: NervousRunState): AttentionBiases {
  const biases = { ...DEFAULT_BIASES };

  const hasSignal = (type: string) => signals.some((s) => s.type === type);

  // User correction — focus hard on latest message, suppress novelty
  if (hasSignal('USER_CORRECTION')) {
    biases.latestUserMessage = 1.5;
    biases.recentFailures = -0.8;
    biases.verifierNodes = 1.0;
    biases.novelRoutes = 0.0;
  }

  // High risk — maximize safety, minimize novelty
  if (state.riskLevel === 'high' || state.riskLevel === 'critical') {
    biases.safetyNodes = 1.5;
    biases.verifierNodes = 1.3;
    biases.novelRoutes = -0.8;
    biases.lowCostRoutes = 0.2;
  }

  // Creative/research tasks — allow more novelty
  if (state.taskType === 'creative' || state.taskType === 'research') {
    biases.novelRoutes = 0.8;
    biases.safetyNodes = 0.6;
    biases.verifierNodes = 0.3;
  }

  // Recovery mode — focus on safety and verification
  if (state.recoveryMode) {
    biases.safetyNodes = 1.5;
    biases.verifierNodes = 1.5;
    biases.novelRoutes = -1.0;
    biases.recentFailures = -1.0;
  }

  // User escalation — prioritize speed
  if (hasSignal('USER_ESCALATION')) {
    biases.lowCostRoutes = 0.8;
    biases.freshSources = 0.6;
  }

  // Cost pressure — cheap routes preferred
  if (hasSignal('COST_SPIKE') || hasSignal('TOKEN_PRESSURE')) {
    biases.lowCostRoutes = 0.9;
    biases.novelRoutes = 0.0;
  }

  return biases;
}
