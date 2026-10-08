import type { Message } from 'ollama';
import type { IChatClient } from '../../core/chatClient';
import { probeContextWindow, usableContextProbe } from './usableContext';

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
  it('sizes the probe window to the probe, within the model window', () => {
    expect(probeContextWindow(200_000)).toBe(40_512);
    expect(probeContextWindow(8_192)).toBe(8_192);
    expect(probeContextWindow(null, 4_000)).toBe(5_512);
  });

  it('reports a measured limit when retrieval fails at a longer length', async () => {
    const result = await usableContextProbe.run(needleClient(5_000), { maxContextTokens: 16_000, tokenBudget: 1_000_000 });
    expect(result.details).toMatchObject({ usableContextTokens: 4096, measuredLimit: true, failedAtTokens: 8192 });
  });

  it('reports the real prompt tokens handled when the backend counts more tokens than words', async () => {
    const inner = needleClient(5_000);
    const client = {
      ...inner,
      chat: async (messages: Message[]) => {
        const result = await inner.chat(messages);
        return { ...result, usage: { promptTokens: (result.usage?.promptTokens ?? 0) * 3, completionTokens: 3 } };
      },
    } as unknown as IChatClient;
    const result = await usableContextProbe.run(client, { maxContextTokens: 16_000, tokenBudget: 10_000_000 });
    expect(result.details).toMatchObject({ measuredLimit: true, failedAtTokens: 8192 });
    expect(Number(result.details.usableContextTokens)).toBeGreaterThan(12_000);
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
