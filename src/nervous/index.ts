// Nervous System — public API
export { SignalBus, createSignal, type NervousSignal, type SignalType, type SignalSeverity, type SignalHandler } from './signals';
export { inspectUserQuery, inspectToolResult, inspectVerifierResult, inspectLoopBehavior, inspectContextPressure } from './sensory';
export { createRunState, evaluateReflexes, type NervousRunState, type ReflexEvaluation } from './reflexes';
export { calculateAttentionBiases, type AttentionBiases } from './attention';
export { checkMotorPermission, type MotorPermission, type MotorDecision } from './motor';
export { extractPainSignals, aggregatePainMultiplier, isSafetyRewardSignal, type PainSignal } from './pain';
export { buildRecoveryPlan, formatRecoveryPlan, type RecoveryPlan } from './recovery';
export { NervousSystemController, type NervousSystemResult } from './controller';
