import { governAnswer } from './governedAnswer';
import type { ContinuityCheckpoint } from '../types';

const checkpoint: ContinuityCheckpoint = {
  sessionId: 's1',
  timestamp: '2026-06-11T00:00:00.000Z',
  summary: 'summary',
  currentGoal: 'Ship the governed loop',
  recentMessages: [],
  pendingToolCalls: [],
  openQuestions: [],
  nextAction: 'Review',
  tokenEstimate: 10,
  contextPressure: 0.1,
  strategy: 'snip' as ContinuityCheckpoint['strategy'],
};

describe('governAnswer', () => {
  it('passes the answer text through untouched (shadow-safe)', () => {
    const out = governAnswer({ answer: 'The capital is Paris.', signals: { brainCitations: 1, confidence: 0.9 } });
    expect(out.answer).toBe('The capital is Paris.');
  });

  it('composes confidence mode and critique together', () => {
    const out = governAnswer({ answer: 'x', signals: { unsavedWebSources: 2, confidence: 0.8 } });
    expect(out.confidence.mode).toBe('found-online-unsaved');
    expect(out.critique.overall).toBe('ok');
  });

  it('builds a working-memory snapshot when a checkpoint is supplied', () => {
    const out = governAnswer({ answer: 'x', signals: { brainCitations: 1 }, checkpoint });
    expect(out.workingMemory?.currentGoal).toBe('Ship the governed loop');
  });

  it('returns null working memory without a checkpoint', () => {
    const out = governAnswer({ answer: 'x', signals: {} });
    expect(out.workingMemory).toBeNull();
  });

  it('stages brain-update proposals without writing them', () => {
    const out = governAnswer({
      answer: 'x',
      signals: { unsavedWebSources: 1, confidence: 0.8 },
      brainUpdateCandidates: [{ content: 'fact', reason: 'found online' }],
    });
    expect(out.proposedBrainUpdates).toEqual([{ content: 'fact', reason: 'found online' }]);
  });

  it('marks a low-confidence answer for review', () => {
    const out = governAnswer({ answer: 'x', signals: { confidence: 0.1 } });
    expect(out.confidence.mode).toBe('needs-review');
    expect(out.critique.overall).toBe('review');
  });
});
