// Execution Readiness Gate — unified scoring before action execution.
//
// Combines confidence, schema validity, verifier score, ambiguity,
// risk, and reliability into a single Execution Readiness Score (ERS).
//
// ERS >= 0.80: execute if permitted
// ERS 0.60-0.79: dry-run, ask clarification, or route to verifier
// ERS < 0.60: escalate to stronger model or ask user

// ─── Types ──────────────────────────────────────────────────────────

export type ReadinessDecision = 'execute' | 'verify' | 'escalate';

export interface ReadinessInput {
  /** Model's self-reported or estimated confidence (0-1). */
  model_confidence?: number;
  /** Schema validation score (0-1). */
  schema_validity?: number;
  /** Verifier score from heuristic or real verifier (0-1). */
  verifier_score?: number;
  /** Ambiguity score — higher means more ambiguous (0-1). */
  ambiguity_score?: number;
  /** Task risk level (0-1, where 1 = highest risk). */
  risk_score?: number;
  /** Historical model reliability for this task type (0-1). */
  model_reliability?: number;
  /** Tool success ratio for tools used (0-1). */
  tool_reliability?: number;
}

export interface ReadinessResult {
  score: number;
  decision: ReadinessDecision;
  components: Record<string, number>;
  reasons: string[];
}

// ─── Weights ────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
  model_confidence: 0.20,
  schema_validity: 0.15,
  verifier_score: 0.20,
  ambiguity: 0.10,       // inverted: low ambiguity = high readiness
  risk: 0.15,            // inverted: low risk = high readiness
  model_reliability: 0.10,
  tool_reliability: 0.10,
};

// ─── Thresholds ─────────────────────────────────────────────────────

const EXECUTE_THRESHOLD = 0.80;
const VERIFY_THRESHOLD = 0.60;

// ─── Calculator ─────────────────────────────────────────────────────

export function calculateReadiness(input: ReadinessInput): ReadinessResult {
  const components: Record<string, number> = {};
  const reasons: string[] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  // Model confidence
  if (input.model_confidence !== undefined) {
    components.model_confidence = input.model_confidence;
    weightedSum += input.model_confidence * DEFAULT_WEIGHTS.model_confidence;
    totalWeight += DEFAULT_WEIGHTS.model_confidence;
    if (input.model_confidence < 0.4) reasons.push(`Low model confidence: ${(input.model_confidence * 100).toFixed(0)}%`);
  }

  // Schema validity
  if (input.schema_validity !== undefined) {
    components.schema_validity = input.schema_validity;
    weightedSum += input.schema_validity * DEFAULT_WEIGHTS.schema_validity;
    totalWeight += DEFAULT_WEIGHTS.schema_validity;
    if (input.schema_validity < 0.5) reasons.push(`Schema validation issues: ${(input.schema_validity * 100).toFixed(0)}%`);
  }

  // Verifier score
  if (input.verifier_score !== undefined) {
    components.verifier_score = input.verifier_score;
    weightedSum += input.verifier_score * DEFAULT_WEIGHTS.verifier_score;
    totalWeight += DEFAULT_WEIGHTS.verifier_score;
    if (input.verifier_score < 0.5) reasons.push(`Verifier score low: ${(input.verifier_score * 100).toFixed(0)}%`);
  }

  // Ambiguity (inverted: high ambiguity = low readiness)
  if (input.ambiguity_score !== undefined) {
    const inverted = 1 - input.ambiguity_score;
    components.ambiguity = inverted;
    weightedSum += inverted * DEFAULT_WEIGHTS.ambiguity;
    totalWeight += DEFAULT_WEIGHTS.ambiguity;
    if (input.ambiguity_score > 0.6) reasons.push(`High ambiguity: ${(input.ambiguity_score * 100).toFixed(0)}%`);
  }

  // Risk (inverted: high risk = low readiness)
  if (input.risk_score !== undefined) {
    const inverted = 1 - input.risk_score;
    components.risk = inverted;
    weightedSum += inverted * DEFAULT_WEIGHTS.risk;
    totalWeight += DEFAULT_WEIGHTS.risk;
    if (input.risk_score > 0.7) reasons.push(`High risk: ${(input.risk_score * 100).toFixed(0)}%`);
  }

  // Model reliability
  if (input.model_reliability !== undefined) {
    components.model_reliability = input.model_reliability;
    weightedSum += input.model_reliability * DEFAULT_WEIGHTS.model_reliability;
    totalWeight += DEFAULT_WEIGHTS.model_reliability;
    if (input.model_reliability < 0.5) reasons.push(`Low model reliability: ${(input.model_reliability * 100).toFixed(0)}%`);
  }

  // Tool reliability
  if (input.tool_reliability !== undefined) {
    components.tool_reliability = input.tool_reliability;
    weightedSum += input.tool_reliability * DEFAULT_WEIGHTS.tool_reliability;
    totalWeight += DEFAULT_WEIGHTS.tool_reliability;
    if (input.tool_reliability < 0.5) reasons.push(`Low tool reliability: ${(input.tool_reliability * 100).toFixed(0)}%`);
  }

  // Normalize score
  const score = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) / 100 : 0.5;

  // Decision
  let decision: ReadinessDecision;
  if (score >= EXECUTE_THRESHOLD) {
    decision = 'execute';
    if (reasons.length === 0) reasons.push('All readiness checks passed.');
  } else if (score >= VERIFY_THRESHOLD) {
    decision = 'verify';
    reasons.push(`Score ${(score * 100).toFixed(0)}% is in verify range (${VERIFY_THRESHOLD * 100}-${EXECUTE_THRESHOLD * 100}%). Recommend dry-run or verifier review.`);
  } else {
    decision = 'escalate';
    reasons.push(`Score ${(score * 100).toFixed(0)}% is below escalation threshold (${VERIFY_THRESHOLD * 100}%). Escalate to stronger model or ask user.`);
  }

  return { score, decision, components, reasons };
}

/** Quick check: is the action ready to execute? */
export function isReadyToExecute(input: ReadinessInput): boolean {
  return calculateReadiness(input).decision === 'execute';
}

/** Quick check: should we escalate? */
export function shouldEscalate(input: ReadinessInput): boolean {
  return calculateReadiness(input).decision === 'escalate';
}
