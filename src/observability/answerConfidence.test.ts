import {
  assessAnswerConfidence,
  classifyConfidenceScore,
  detectAbstention,
  parseStatedConfidence,
} from './answerConfidence';

describe('classifyConfidenceScore', () => {
  it('maps boundaries to documented bands', () => {
    expect(classifyConfidenceScore(0.75)).toBe('high');
    expect(classifyConfidenceScore(0.9)).toBe('high');
    expect(classifyConfidenceScore(0.74)).toBe('medium');
    expect(classifyConfidenceScore(0.4)).toBe('medium');
    expect(classifyConfidenceScore(0.39)).toBe('low');
    expect(classifyConfidenceScore(0)).toBe('low');
  });
});

describe('detectAbstention', () => {
  it('matches explicit decline phrases case-insensitively', () => {
    expect(detectAbstention("I don't know the answer.").abstained).toBe(true);
    expect(detectAbstention('There is NOT ENOUGH INFORMATION here.').abstained).toBe(true);
    const r = detectAbstention('I cannot determine the cause.');
    expect(r.abstained).toBe(true);
    expect(r.signal).toBe('i cannot determine');
  });

  it('does not treat mere hedging as abstention', () => {
    expect(detectAbstention('I think it is probably 42.').abstained).toBe(false);
    expect(detectAbstention('The answer is 42.').abstained).toBe(false);
  });
});

describe('parseStatedConfidence', () => {
  it('parses decimals and percentages', () => {
    expect(parseStatedConfidence('Confidence: 0.8')).toBe(0.8);
    expect(parseStatedConfidence('confidence 80%')).toBe(0.8);
    expect(parseStatedConfidence('My confidence: 1')).toBe(1);
  });

  it('returns null when no explicit confidence is stated', () => {
    expect(parseStatedConfidence('The answer is 42.')).toBeNull();
    expect(parseStatedConfidence('I am fairly sure about this.')).toBeNull();
  });

  it('rejects out-of-range values', () => {
    expect(parseStatedConfidence('confidence: 250%')).toBeNull();
  });
});

describe('assessAnswerConfidence', () => {
  it('abstention overrides any stated number', () => {
    const v = assessAnswerConfidence("I don't know. confidence: 0.9");
    expect(v.band).toBe('abstained');
    expect(v.abstained).toBe(true);
    expect(v.statedScore).toBeNull();
  });

  it('classifies an explicit stated confidence', () => {
    const v = assessAnswerConfidence('The answer is 42. Confidence: 0.82');
    expect(v.band).toBe('high');
    expect(v.abstained).toBe(false);
    expect(v.statedScore).toBe(0.82);
  });

  it('does not fabricate a score when none is stated', () => {
    const v = assessAnswerConfidence('The answer is 42.');
    expect(v.band).toBe('unstated');
    expect(v.abstained).toBe(false);
    expect(v.statedScore).toBeNull();
  });
});
