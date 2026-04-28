import { applyBudgetReduction, applySnip } from './compaction';
import { estimateTokenCount } from './assembly';
import type { Message } from 'ollama';

describe('Context Compaction', () => {
  describe('applyBudgetReduction', () => {
    it('truncates oversized tool results', () => {
      const longContent = 'x'.repeat(10_000);
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        { role: 'tool', content: longContent },
      ];

      const result = applyBudgetReduction(messages, 500);
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg!.content!.length).toBeLessThan(longContent.length);
      expect(toolMsg!.content).toContain('...(truncated)');
      expect(result.tokensFreed).toBeGreaterThan(0);
    });

    it('leaves small tool results unchanged', () => {
      const messages: Message[] = [
        { role: 'tool', content: 'short result' },
      ];

      const result = applyBudgetReduction(messages, 500);
      expect(result.messages[0].content).toBe('short result');
      expect(result.tokensFreed).toBe(0);
    });
  });

  describe('applySnip', () => {
    it('removes older messages when count exceeds keepCount', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'msg 2' },
        { role: 'assistant', content: 'reply 2' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'reply 3' },
      ];

      const result = applySnip(messages, 3);
      // Should keep system + boundary + last 3 non-system messages
      expect(result.messages.length).toBe(5); // system + boundary + 3 kept
      expect(result.tokensFreed).toBeGreaterThan(0);
      expect(result.messages[result.messages.length - 1].content).toBe('reply 3');
    });

    it('returns unchanged if message count is within keepCount', () => {
      const messages: Message[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];

      const result = applySnip(messages, 5);
      expect(result.messages).toEqual(messages);
      expect(result.tokensFreed).toBe(0);
    });
  });

  describe('estimateTokenCount', () => {
    it('estimates roughly 4 chars per token', () => {
      const messages: Message[] = [
        { role: 'user', content: 'a'.repeat(400) },
      ];
      const count = estimateTokenCount(messages);
      expect(count).toBe(100);
    });
  });
});
