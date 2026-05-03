// Nervous System — Reflex engine.
//
// Immediate rule-based protective responses that fire before or during
// agent execution. Each reflex inspects the current signals and run state,
// then modifies the run state to enforce safety constraints.

import type { NervousSignal } from './signals';

// ─── Run state that reflexes modify ─────────────────────────────────

export interface NervousRunState {
  runId: string;
  taskType: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  urgencyLevel: 'low' | 'normal' | 'high' | 'immediate';
  explorationRate: number;
  dryRunRequired: boolean;
  confirmationRequired: boolean;
  verifierRequired: boolean;
  compressionRequired: boolean;
  interruptRequested: boolean;
  recoveryMode: boolean;
  contextBudgetReduction: number;
  toolCallBudget: number;
  agentStepBudget: number;
  toolErrors: Map<string, number>;
  loopCount: number;
  activeReflexes: string[];
  safetyNotes: string[];
  requiredNodes: string[];
  forbiddenNodes: string[];
}

export function createRunState(runId: string, taskType: string): NervousRunState {
  return {
    runId,
    taskType,
    riskLevel: 'low',
    urgencyLevel: 'normal',
    explorationRate: 0.15,
    dryRunRequired: false,
    confirmationRequired: false,
    verifierRequired: false,
    compressionRequired: false,
    interruptRequested: false,
    recoveryMode: false,
    contextBudgetReduction: 0,
    toolCallBudget: 50,
    agentStepBudget: 20,
    toolErrors: new Map(),
    loopCount: 0,
    activeReflexes: [],
    safetyNotes: [],
    requiredNodes: [],
    forbiddenNodes: [],
  };
}

// ─── Reflex definitions ─────────────────────────────────────────────

interface ReflexResult {
  triggered: boolean;
  reflexName: string;
  action: string;
}

type ReflexFn = (signals: NervousSignal[], state: NervousRunState) => ReflexResult;

// 1. Irreversible Action Reflex
const irreversibleActionReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'IRREVERSIBLE_ACTION');
  if (!sig) return { triggered: false, reflexName: 'irreversible_action', action: '' };
  state.dryRunRequired = true;
  state.confirmationRequired = true;
  state.explorationRate = 0;
  state.verifierRequired = true;
  state.riskLevel = 'critical';
  state.safetyNotes.push('Irreversible action detected. Dry-run and confirmation required.');
  state.requiredNodes.push('safety.no_irreversible_action_without_confirmation');
  return { triggered: true, reflexName: 'irreversible_action', action: 'dry_run + confirmation + zero exploration' };
};

// 2. High-Risk Domain Reflex
const highRiskDomainReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'TASK_RISK' && (s.severity === 'high' || s.severity === 'critical'));
  if (!sig) return { triggered: false, reflexName: 'high_risk_domain', action: '' };
  state.explorationRate = Math.min(state.explorationRate, 0.02);
  state.verifierRequired = true;
  state.riskLevel = state.riskLevel === 'critical' ? 'critical' : 'high';
  state.safetyNotes.push('High-risk domain detected. Exploration minimized.');
  return { triggered: true, reflexName: 'high_risk_domain', action: 'exploration <= 0.02 + verifier required' };
};

// 3. Tool Failure Reflex
const toolFailureReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'REPEATED_FAILURE');
  if (!sig) return { triggered: false, reflexName: 'tool_failure', action: '' };
  const toolName = sig.metadata?.toolName as string | undefined;
  if (toolName) {
    state.forbiddenNodes.push(`tool.${toolName}`);
    state.safetyNotes.push(`Tool ${toolName} has failed repeatedly. Excluded from routing.`);
  }
  return { triggered: true, reflexName: 'tool_failure', action: `excluded tool ${toolName ?? 'unknown'}` };
};

// 4. Agent Loop Reflex
const agentLoopReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'AGENT_LOOP');
  if (!sig) return { triggered: false, reflexName: 'agent_loop', action: '' };
  state.interruptRequested = true;
  state.recoveryMode = true;
  state.agentStepBudget = Math.max(3, Math.floor(state.agentStepBudget / 2));
  state.safetyNotes.push('Agent loop detected. Interrupting and entering recovery.');
  return { triggered: true, reflexName: 'agent_loop', action: 'interrupt + recovery mode' };
};

// 5. Context Overload Reflex
const contextOverloadReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'CONTEXT_OVERLOAD' || s.type === 'COMPRESSION_REQUIRED');
  if (!sig) return { triggered: false, reflexName: 'context_overload', action: '' };
  state.compressionRequired = true;
  state.contextBudgetReduction = Math.max(state.contextBudgetReduction, 0.3);
  state.safetyNotes.push('Context overload. Compression triggered.');
  return { triggered: true, reflexName: 'context_overload', action: 'compression + 30% budget reduction' };
};

// 6. User Correction Reflex
const userCorrectionReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'USER_CORRECTION');
  if (!sig) return { triggered: false, reflexName: 'user_correction', action: '' };
  state.verifierRequired = true;
  state.explorationRate = Math.min(state.explorationRate, 0.05);
  state.safetyNotes.push('User corrected previous output. Routing through verifier.');
  state.requiredNodes.push('verifier.task_completion');
  return { triggered: true, reflexName: 'user_correction', action: 'verifier required + reduced exploration' };
};

// 7. Low Confidence Reflex
const lowConfidenceReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'LOW_CONFIDENCE');
  if (!sig) return { triggered: false, reflexName: 'low_confidence', action: '' };
  state.verifierRequired = true;
  state.safetyNotes.push('Low confidence detected. Verification required.');
  return { triggered: true, reflexName: 'low_confidence', action: 'verifier required' };
};

// 8. Privacy Reflex
const privacyReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'PRIVACY_RISK');
  if (!sig) return { triggered: false, reflexName: 'privacy', action: '' };
  state.riskLevel = state.riskLevel === 'critical' ? 'critical' : 'high';
  state.safetyNotes.push('Privacy risk detected. Sensitive data may be involved.');
  state.requiredNodes.push('safety.protect_private_data');
  return { triggered: true, reflexName: 'privacy', action: 'privacy protection + safety node required' };
};

// 9. Cost Spike Reflex
const costSpikeReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'COST_SPIKE');
  if (!sig) return { triggered: false, reflexName: 'cost_spike', action: '' };
  state.explorationRate = Math.min(state.explorationRate, 0.05);
  state.toolCallBudget = Math.max(5, Math.floor(state.toolCallBudget / 2));
  state.safetyNotes.push('Cost spike detected. Reducing tool budget and exploration.');
  return { triggered: true, reflexName: 'cost_spike', action: 'tool budget halved + exploration reduced' };
};

// 10. Recovery Reflex
const recoveryReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'RECOVERY_REQUIRED');
  if (!sig || state.recoveryMode) return { triggered: false, reflexName: 'recovery', action: '' };
  state.recoveryMode = true;
  state.explorationRate = 0;
  state.verifierRequired = true;
  state.safetyNotes.push('Recovery mode activated. Minimal safe actions only.');
  return { triggered: true, reflexName: 'recovery', action: 'recovery mode + zero exploration + verifier' };
};

// 11. Ongoing Service Request Reflex
// Detects requests for ongoing behaviour (reminders, task management,
// monitoring, check-ins) and suppresses BUILD mode in favour of OPERATE mode.
const ongoingServiceReflex: ReflexFn = (signals, state) => {
  const sig = signals.find((s) => s.type === 'ONGOING_SERVICE_REQUEST');
  if (!sig) return { triggered: false, reflexName: 'ongoing_service_request', action: '' };
  state.safetyNotes.push('Ongoing service request detected. Classified as OPERATE mode; BUILD mode suppressed unless explicitly requested.');
  state.requiredNodes.push('service.operate_mode');
  return { triggered: true, reflexName: 'ongoing_service_request', action: 'classify as OPERATE, suppress BUILD' };
};

// ─── All reflexes in evaluation order ───────────────────────────────

const ALL_REFLEXES: ReflexFn[] = [
  irreversibleActionReflex,
  highRiskDomainReflex,
  privacyReflex,
  toolFailureReflex,
  agentLoopReflex,
  contextOverloadReflex,
  userCorrectionReflex,
  lowConfidenceReflex,
  costSpikeReflex,
  recoveryReflex,
  ongoingServiceReflex,
];

// ─── Evaluate all reflexes ──────────────────────────────────────────

export interface ReflexEvaluation {
  triggered: ReflexResult[];
  state: NervousRunState;
}

export function evaluateReflexes(signals: NervousSignal[], state: NervousRunState): ReflexEvaluation {
  const triggered: ReflexResult[] = [];
  for (const reflex of ALL_REFLEXES) {
    const result = reflex(signals, state);
    if (result.triggered) {
      triggered.push(result);
      state.activeReflexes.push(result.reflexName);
    }
  }
  return { triggered, state };
}
