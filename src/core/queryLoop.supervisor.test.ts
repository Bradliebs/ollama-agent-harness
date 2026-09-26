import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import type { LoopConfig, LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const probeTool: Tool = {
  name: 'probe',
  description: 'probe',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  isReadOnly: true,
  execute: async () => ({ success: true, output: 'same answer every time' }),
};

function loopingClient(finalText: string, usage = { promptTokens: 100, completionTokens: 10 }) {
  const sent: Message[][] = [];
  let calls = 0;
  return {
    sent,
    chat: jest.fn(async (messages: Message[], tools: unknown[]) => {
      sent.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      calls += 1;
      if (!tools || (tools as unknown[]).length === 0) {
        return { message: { role: 'assistant', content: finalText } as Message, usage };
      }
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'probe', arguments: { q: `attempt ${calls}` } } }] } as Message, usage };
    }),
  };
}

async function collect(client: ReturnType<typeof loopingClient>, config: Partial<LoopConfig>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'fixture-model', systemPrompt: 'system', maxTurns: 12, context: { enabled: false }, ...config },
    { client: client as never, tools: [probeTool] },
    [{ role: 'user', content: 'find it' }],
  )) events.push(event);
  return events;
}

describe('queryLoop supervisor', () => {
  it('escalates stalled turns and ends by asking the human what is blocking', async () => {
    const client = loopingClient('I am stuck: the probe keeps returning the same answer. Which source should I use?');
    const events = await collect(client, { supervisor: { stallTurns: 2 } });

    const stages = events.filter((event) => event.type === 'supervisor').map((event) => (event.type === 'supervisor' ? event.stage : ''));
    expect(stages).toEqual(['warn', 'change_strategy', 'ask_human']);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'stuck_needs_human' });

    // The warn/change-strategy nudges reached the model; the final call is a
    // tool-less synthesis carrying the ask-human instruction.
    const allSent = client.sent.flat().map((m) => String(m.content));
    expect(allSent.some((text) => text.startsWith('⚠️ Progress check'))).toBe(true);
    expect(allSent.some((text) => text.includes('Change strategy'))).toBe(true);
    const synthesis = client.sent[client.sent.length - 1];
    expect(String(synthesis[synthesis.length - 1].content)).toContain('Stop using tools');
    expect(events.filter((event) => event.type === 'text').map((event) => (event.type === 'text' ? event.content : '')).join('')).toContain('Which source should I use?');
  });

  it('stops into synthesis when the per-run token budget is exceeded', async () => {
    const client = loopingClient('Here is what I found within budget.', { promptTokens: 30_000, completionTokens: 1_000 });
    const events = await collect(client, { supervisor: { maxTokens: 50_000 } });
    expect(events.find((event) => event.type === 'budget_exceeded')).toMatchObject({ which: 'tokens', limit: 50_000 });
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'budget_synthesized' });
    expect(client.chat).toHaveBeenCalledTimes(3);
  });

  it('can be disabled per run', async () => {
    const client = loopingClient('done');
    const events = await collect(client, { supervisor: false, maxTurns: 8 });
    expect(events.some((event) => event.type === 'supervisor')).toBe(false);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'max_turns_synthesized' });
  });
});
