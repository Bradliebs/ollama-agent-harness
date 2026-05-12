import { calculateReadiness, isReadyToExecute, shouldEscalate } from './readinessGate';

describe('readinessGate', () => {
  it('returns execute for high scores', () => {
    const result = calculateReadiness({
      model_confidence: 0.95,
      schema_validity: 1.0,
      verifier_score: 0.9,
      ambiguity_score: 0.1,
      risk_score: 0.1,
      model_reliability: 0.9,
      tool_reliability: 0.95,
    });
    expect(result.decision).toBe('execute');
    expect(result.score).toBeGreaterThanOrEqual(0.80);
  });

  it('returns verify for medium scores', () => {
    const result = calculateReadiness({
      model_confidence: 0.6,
      schema_validity: 0.8,
      verifier_score: 0.6,
      ambiguity_score: 0.4,
      risk_score: 0.3,
      model_reliability: 0.7,
      tool_reliability: 0.7,
    });
    expect(result.decision).toBe('verify');
    expect(result.score).toBeGreaterThanOrEqual(0.60);
    expect(result.score).toBeLessThan(0.80);
  });

  it('returns escalate for low scores', () => {
    const result = calculateReadiness({
      model_confidence: 0.2,
      schema_validity: 0.3,
      verifier_score: 0.2,
      ambiguity_score: 0.9,
      risk_score: 0.9,
      model_reliability: 0.3,
      tool_reliability: 0.3,
    });
    expect(result.decision).toBe('escalate');
    expect(result.score).toBeLessThan(0.60);
  });

  it('handles partial inputs gracefully', () => {
    // Only confidence provided
    const result = calculateReadiness({ model_confidence: 0.95 });
    expect(result.decision).toBe('execute');
    expect(result.components.model_confidence).toBe(0.95);
  });

  it('handles empty input', () => {
    const result = calculateReadiness({});
    expect(result.score).toBe(0.5); // default when no inputs
  });

  it('includes reasons for each low component', () => {
    const result = calculateReadiness({
      model_confidence: 0.2,
      schema_validity: 0.3,
      verifier_score: 0.1,
    });
    expect(result.reasons.some((r) => r.includes('confidence'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('Schema'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('Verifier'))).toBe(true);
  });

  it('high ambiguity lowers readiness', () => {
    const low = calculateReadiness({ model_confidence: 0.9, ambiguity_score: 0.1 });
    const high = calculateReadiness({ model_confidence: 0.9, ambiguity_score: 0.9 });
    expect(low.score).toBeGreaterThan(high.score);
  });

  it('high risk lowers readiness', () => {
    const low = calculateReadiness({ model_confidence: 0.9, risk_score: 0.1 });
    const high = calculateReadiness({ model_confidence: 0.9, risk_score: 0.9 });
    expect(low.score).toBeGreaterThan(high.score);
  });

  it('isReadyToExecute shortcut works', () => {
    expect(isReadyToExecute({ model_confidence: 0.95, verifier_score: 0.9 })).toBe(true);
    expect(isReadyToExecute({ model_confidence: 0.2, verifier_score: 0.2 })).toBe(false);
  });

  it('shouldEscalate shortcut works', () => {
    expect(shouldEscalate({ model_confidence: 0.2, verifier_score: 0.1, risk_score: 0.9 })).toBe(true);
    expect(shouldEscalate({ model_confidence: 0.95 })).toBe(false);
  });

  it('components are recorded in result', () => {
    const result = calculateReadiness({
      model_confidence: 0.8,
      schema_validity: 0.9,
      risk_score: 0.3,
    });
    expect(result.components.model_confidence).toBe(0.8);
    expect(result.components.schema_validity).toBe(0.9);
    expect(result.components.risk).toBe(0.7); // inverted: 1 - 0.3
  });
});
