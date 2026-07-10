import { buildWorkingMemory } from './workingMemory';
import type { ContinuityCheckpoint } from '../types';

function checkpoint(overrides: Partial<ContinuityCheckpoint> = {}): ContinuityCheckpoint {
  return {
    sessionId: 's1',
    timestamp: '2026-06-11T00:00:00.000Z',
    summary: 'summary',
    currentGoal: 'Ship the governed loop',
    recentMessages: [],
    pendingToolCalls: [],
    openQuestions: ['What is the review threshold?'],
    nextAction: 'Write the working-memory route',
    tokenEstimate: 100,
    contextPressure: 0.2,
    strategy: 'snip' as ContinuityCheckpoint['strategy'],
    ...overrides,
  };
}

describe('buildWorkingMemory', () => {
  it('maps checkpoint fields into the unified object', () => {
    const wm = buildWorkingMemory(checkpoint());
    expect(wm.currentGoal).toBe('Ship the governed loop');
    expect(wm.openQuestions).toEqual(['What is the review threshold?']);
    expect(wm.nextAction).toBe('Write the working-memory route');
    expect(wm.updatedAt).toBe('2026-06-11T00:00:00.000Z');
    expect(wm.assumptions).toEqual([]);
    expect(wm.decisions).toEqual([]);
  });

  it('derives blocked items from pending tool calls', () => {
    const wm = buildWorkingMemory(checkpoint({ pendingToolCalls: ['web_fetch', 'run_tests'] }));
    expect(wm.blocked).toEqual(['pending: web_fetch', 'pending: run_tests']);
  });

  it('lets extras override assumptions, decisions, and blocked', () => {
    const wm = buildWorkingMemory(checkpoint({ pendingToolCalls: ['x'] }), {
      assumptions: ['node >= 18'],
      decisions: ['use pure modules'],
      blocked: ['waiting on review'],
    });
    expect(wm.assumptions).toEqual(['node >= 18']);
    expect(wm.decisions).toEqual(['use pure modules']);
    expect(wm.blocked).toEqual(['waiting on review']);
  });
});
