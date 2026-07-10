import { classifyConfidenceMode } from './confidenceMode';

describe('classifyConfidenceMode', () => {
  it('flags abstention as needs-review', () => {
    expect(classifyConfidenceMode({ abstained: true, brainCitations: 3 }).mode).toBe('needs-review');
  });

  it('flags source conflict as needs-review', () => {
    expect(classifyConfidenceMode({ conflict: true, brainCitations: 2, confidence: 0.9 }).mode).toBe('needs-review');
  });

  it('flags low confidence as needs-review', () => {
    expect(classifyConfidenceMode({ confidence: 0.2, brainCitations: 1 }).mode).toBe('needs-review');
  });

  it('labels fresh unsaved web findings', () => {
    const r = classifyConfidenceMode({ unsavedWebSources: 2, brainCitations: 0, confidence: 0.8 });
    expect(r.mode).toBe('found-online-unsaved');
  });

  it('labels stored-knowledge answers as from-brain', () => {
    expect(classifyConfidenceMode({ brainCitations: 4, confidence: 0.9 }).mode).toBe('from-brain');
  });

  it('prefers from-brain when both brain and web sources are present', () => {
    expect(classifyConfidenceMode({ brainCitations: 1, unsavedWebSources: 3, confidence: 0.9 }).mode).toBe('from-brain');
  });

  it('labels uncited confident answers as inferred', () => {
    expect(classifyConfidenceMode({ confidence: 1 }).mode).toBe('inferred');
  });

  it('respects a custom review threshold', () => {
    expect(classifyConfidenceMode({ confidence: 0.5, brainCitations: 1 }, 0.7).mode).toBe('needs-review');
  });
});
