import type { Message } from 'ollama';
import type { IChatClient } from '../../core/chatClient';
import { usableContextProbe } from './usableContext';

function needleClient(maxRetrievableTokens: number): IChatClient {
  return {
    chat: jest.fn(async (messages: Message[]) => {
      const prompt = String(messages[messages.length - 1]?.content ?? '');
      const words = prompt.split(' ').length;
      const needle = prompt.match(/NEEDLE_\d+_\d+_VALUE/)?.[0] ?? '';
      return { message: { role: 'assistant', content: words <= maxRetrievableTokens ? needle : 'not sure' } as Message, usage: { promptTokens: words, completionTokens: 3 } };
    }),
    getContextWindow: async () => 200_000,
  } as unknown as IChatClient;
}

describe('usableContextProbe', () => {
  it('reports a measured limit when retrieval fails at a longer length', async () => {
    const result = await usableContextProbe.run(needleClient(5_000), { maxContextTokens: 16_000, tokenBudget: 1_000_000 });
    expect(result.details).toMatchObject({ usableContextTokens: 4096, measuredLimit: true, failedAtTokens: 8192 });
  });

  it('reports a lower bound when every tested length passes', async () => {
    const result = await usableContextProbe.run(needleClient(1_000_000), { maxContextTokens: 16_000, tokenBudget: 1_000_000 });
    expect(result.details).toMatchObject({ usableContextTokens: 16_000, measuredLimit: false, failedAtTokens: null });
  });

  it('reports a lower bound when the token budget runs out first', async () => {
    const result = await usableContextProbe.run(needleClient(1_000_000), { maxContextTokens: 32_000, tokenBudget: 30_000 });
    expect(result.details).toMatchObject({ measuredLimit: false });
    expect(Number(result.details.usableContextTokens)).toBeLessThan(32_000);
  });
});
