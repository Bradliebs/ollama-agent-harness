import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import type { LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const bulkyTool = (name: string): Tool => ({
  name,
  description: `${name} `.repeat(400),
  parameters: { type: 'object', properties: { q: { type: 'string', description: 'query '.repeat(100) } } },
  isReadOnly: true,
  execute: async () => ({ success: true, output: 'ok' }),
});

async function run(maxTokens: number, tools: Tool[]): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  const chat = jest.fn(async () => ({ message: { role: 'assistant', content: 'done' } as Message }));
  for await (const event of queryLoop(
    { model: 'm', systemPrompt: 'system', maxTurns: 2, context: { maxTokens }, supervisor: false },
    { client: { chat } as never, tools },
    [{ role: 'user', content: 'hello '.repeat(200) }],
  )) events.push(event);
  return events;
}

describe('queryLoop token budget', () => {
  it('counts tool definitions against the context limit', async () => {
    const tools = [bulkyTool('alpha'), bulkyTool('beta'), bulkyTool('gamma')];
    const events = await run(2400, tools);
    const breakdown = events.find((event) => event.type === 'context_breakdown');
    expect(breakdown).toMatchObject({ toolSchemaTokens: expect.any(Number) });
    expect((breakdown as { toolSchemaTokens: number }).toolSchemaTokens).toBeGreaterThan(1500);
    expect(events.some((event) => event.type === 'context_warning')).toBe(true);
  });

  it('stays quiet when the same transcript fits without bulky tools', async () => {
    const events = await run(2400, []);
    expect(events.some((event) => event.type === 'context_warning')).toBe(false);
    expect(events.some((event) => event.type === 'context_breakdown')).toBe(false);
  });

  it('reports the summarizer call of an auto-compaction as compaction usage', async () => {
    const events: LoopEvent[] = [];
    const usage = { promptTokens: 900, completionTokens: 60, totalDurationNs: 1_000_000 };
    const chat = jest.fn(async (messages: Message[]) => (
      String(messages[0]?.content).startsWith('You are a conversation summarizer')
        ? { message: { role: 'assistant', content: 'earlier: user asked about alpha beta gamma' } as Message, usage }
        : { message: { role: 'assistant', content: 'done' } as Message, usage: { promptTokens: 50, completionTokens: 5, totalDurationNs: 0 } }
    ));
    const history: Message[] = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `alpha beta gamma ${i} ${'x'.repeat(600)}` }));
    for await (const event of queryLoop(
      { model: 'm', systemPrompt: 'system', maxTurns: 2, context: { maxTokens: 1400, minSummaryQuality: 0 }, supervisor: false },
      { client: { chat, getModel: () => 'm' } as never, tools: [] },
      history,
    )) events.push(event);
    const compactionUsage = events.find((event) => event.type === 'usage' && event.purpose === 'compaction');
    expect(compactionUsage).toMatchObject({ promptTokens: 900, completionTokens: 60, model: 'm' });
  });

  it('does not count tool definitions against the 8192 default when the caller gives no window', async () => {
    const events: LoopEvent[] = [];
    const chat = jest.fn(async () => ({ message: { role: 'assistant', content: 'done' } as Message }));
    const tools = Array.from({ length: 12 }, (_, i) => bulkyTool(`tool${i}`));
    for await (const event of queryLoop(
      { model: 'm', systemPrompt: 'system', maxTurns: 2, supervisor: false },
      { client: { chat } as never, tools },
      [{ role: 'user', content: 'hello' }],
    )) events.push(event);
    expect(events.some((event) => event.type === 'context_warning' || event.type === 'context')).toBe(false);
  });
});
