import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import type { LoopConfig } from '../types';
import type { ModelLocality } from './chatClient';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

function makeConfig(model: string): LoopConfig {
  return {
    model,
    systemPrompt: 'system',
    maxTurns: 3,
    context: { enabled: false },
  };
}

/** Single text reply with usage, optionally advertising a locality. */
function makeClient(locality?: ModelLocality) {
  const reply: Message = { role: 'assistant', content: 'done' };
  const sent = [reply];
  return {
    chat: jest.fn().mockImplementation(async () => ({
      message: sent.shift(),
      usage: { promptTokens: 5, completionTokens: 3, totalDurationNs: 1_000_000 },
    })),
    ...(locality ? { getLocality: () => locality } : {}),
  };
}

async function firstUsage(client: ReturnType<typeof makeClient>, model: string) {
  for await (const event of queryLoop(
    makeConfig(model),
    { client: client as never, tools: [] },
    [{ role: 'user', content: 'hello' }],
  )) {
    if (event.type === 'usage') return event;
  }
  return undefined;
}

describe('queryLoop usage locality', () => {
  it('uses the serving client locality signal when present', async () => {
    const usage = await firstUsage(makeClient('local'), 'some-custom-local-pull');
    expect(usage?.locality).toBe('local');
  });

  it('falls back to registry classification for cloud models when client is silent', async () => {
    const usage = await firstUsage(makeClient(), 'gpt-4.1');
    expect(usage?.locality).toBe('cloud');
  });

  it('reports unknown for off-registry models when client is silent', async () => {
    const usage = await firstUsage(makeClient(), 'totally-unknown-model');
    expect(usage?.locality).toBe('unknown');
  });
});
