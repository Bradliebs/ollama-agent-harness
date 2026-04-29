import { createContinuityCheckpoint } from './continuity';
import type { Message } from 'ollama';

describe('createContinuityCheckpoint', () => {
  it('captures goal, recent messages, and context pressure', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Build auto recovery for long sessions' },
      { role: 'assistant', content: 'Next: add tests for recovery?' },
    ];

    const checkpoint = createContinuityCheckpoint({
      sessionId: 'abc',
      messages,
      summary: 'Implemented continuity foundation',
      strategy: 'auto_compact',
      maxTokens: 100,
    });

    expect(checkpoint.currentGoal).toContain('Build auto recovery');
    expect(checkpoint.openQuestions).toEqual(['Next: add tests for recovery?']);
    expect(checkpoint.contextPressure).toBeGreaterThan(0);
  });
});
