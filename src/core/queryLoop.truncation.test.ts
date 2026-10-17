import type { Message } from 'ollama';
import { CONTINUE_TRUNCATED_PROMPT, TRUNCATED_THINKING_PROMPT, TRUNCATED_TOOL_CALL_PROMPT, queryLoop } from './queryLoop';
import type { ChatResult } from './chatClient';
import type { LoopConfig, LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({ trackToolUsage: jest.fn().mockResolvedValue(undefined) }));

const usage = { promptTokens: 1, completionTokens: 1, totalDurationNs: 0 };
const config = (overrides: Partial<LoopConfig> = {}): LoopConfig => ({ model: 'm', systemPrompt: 'system', maxTurns: 6, context: { enabled: false }, ...overrides });

function scriptedClient(replies: ChatResult[]) {
  const seen: Message[][] = [];
  return {
    seen,
    chat: jest.fn(async (messages: Message[]) => {
      seen.push(messages.map((m) => ({ ...m })));
      const next = replies.shift();
      if (!next) throw new Error('no more replies');
      return next;
    }),
  };
}

const writeCall = { function: { name: 'file_write', arguments: { path: 'game.html' } } };

describe('queryLoop output-limit truncation', () => {
  it('continues a cut-off answer and keeps both parts', async () => {
    const client = scriptedClient([
      { message: { role: 'assistant', content: 'The first half of the answer' }, usage, truncated: true },
      { message: { role: 'assistant', content: ' and the second half.' }, usage },
    ]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config(), { client: client as never, tools: [] }, [{ role: 'user', content: 'explain' }])) events.push(event);
    expect(events).toEqual(expect.arrayContaining([{ type: 'output_limit', turn: 1, droppedToolCalls: 0, continuing: true }]));
    const texts = events.filter((e): e is Extract<LoopEvent, { type: 'text' }> => e.type === 'text').map((e) => e.content);
    expect(texts.join('')).toBe('The first half of the answer and the second half.');
    expect(client.seen[1][client.seen[1].length - 1]).toEqual({ role: 'user', content: CONTINUE_TRUNCATED_PROMPT });
  });

  it('does not run a cut-off tool call and asks for smaller parts', async () => {
    const execute = jest.fn(async () => ({ success: true, output: 'ok' }));
    const tools: Tool[] = [{ name: 'file_write', description: 'write', parameters: { type: 'object', properties: {} }, isReadOnly: false, execute }];
    const client = scriptedClient([
      { message: { role: 'assistant', content: '', tool_calls: [writeCall] } as Message, usage, truncated: true },
      { message: { role: 'assistant', content: 'Done in parts.' }, usage },
    ]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config(), { client: client as never, tools, permissionCheck: async () => ({ allowed: true }) }, [{ role: 'user', content: 'build a game' }])) events.push(event);
    expect(execute).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([{ type: 'output_limit', turn: 1, droppedToolCalls: 1, continuing: true }]));
    const second = client.seen[1];
    expect(second[second.length - 1]).toEqual({ role: 'user', content: TRUNCATED_TOOL_CALL_PROMPT });
    // The cut-off assistant turn stays in history without its tool call.
    expect(second[second.length - 2]).toEqual({ role: 'assistant', content: '' });
  });

  it('stops continuing after two cut-offs and says why', async () => {
    const execute = jest.fn(async () => ({ success: true, output: 'ok' }));
    const tools: Tool[] = [{ name: 'file_write', description: 'write', parameters: { type: 'object', properties: {} }, isReadOnly: false, execute }];
    const cut = (): ChatResult => ({ message: { role: 'assistant', content: '', tool_calls: [writeCall] } as Message, usage, truncated: true });
    const client = scriptedClient([cut(), cut(), cut(), { message: { role: 'assistant', content: 'synthesis' }, usage }]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config(), { client: client as never, tools, permissionCheck: async () => ({ allowed: true }) }, [{ role: 'user', content: 'build a game' }])) events.push(event);
    expect(execute).not.toHaveBeenCalled();
    const limits = events.filter((e) => e.type === 'output_limit');
    expect(limits.map((e) => (e as { continuing: boolean }).continuing)).toEqual([true, true, false]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', message: expect.stringContaining('cut off at its output limit again') })]));
  });

  it('counts cut-offs per streak, so a later file gets its own retries', async () => {
    const execute = jest.fn(async () => ({ success: true, output: 'ok' }));
    const tools: Tool[] = [{ name: 'file_write', description: 'write', parameters: { type: 'object', properties: {} }, isReadOnly: false, execute }];
    const cut = (): ChatResult => ({ message: { role: 'assistant', content: '', tool_calls: [writeCall] } as Message, usage, truncated: true });
    const write = (): ChatResult => ({ message: { role: 'assistant', content: '', tool_calls: [writeCall] } as Message, usage });
    const client = scriptedClient([cut(), cut(), write(), cut(), cut(), write(), { message: { role: 'assistant', content: 'Both files written.' }, usage }]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config({ maxTurns: 10 }), { client: client as never, tools, permissionCheck: async () => ({ allowed: true }) }, [{ role: 'user', content: 'build a game' }])) events.push(event);
    const limits = events.filter((e) => e.type === 'output_limit');
    expect(limits.map((e) => (e as { continuing: boolean }).continuing)).toEqual([true, true, true, true]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('asks for a direct answer when a thinking model wrote nothing before the limit', async () => {
    const client = scriptedClient([
      { message: { role: 'assistant', content: '' }, usage, truncated: true },
      { message: { role: 'assistant', content: 'The answer.' }, usage },
    ]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config(), { client: client as never, tools: [] }, [{ role: 'user', content: 'explain' }])) events.push(event);
    const second = client.seen[1];
    expect(second[second.length - 1]).toEqual({ role: 'user', content: TRUNCATED_THINKING_PROMPT });
    expect(second.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('does not continue when the context window is full, and says so', async () => {
    const client = scriptedClient([
      { message: { role: 'assistant', content: 'Partial answer' }, usage: { promptTokens: 7_900, completionTokens: 200, totalDurationNs: 0 }, truncated: true },
    ]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config({ context: { enabled: false, maxTokens: 8_192 } }), { client: client as never, tools: [] }, [{ role: 'user', content: 'explain' }])) events.push(event);
    expect(events).toEqual(expect.arrayContaining([{ type: 'output_limit', turn: 1, droppedToolCalls: 0, continuing: false, contextFull: true }]));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', message: expect.stringContaining("filled the model's context window") })]));
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('does not continue a tool call written as JSON text', async () => {
    const client = scriptedClient([{ message: { role: 'assistant', content: '{"tool": "file_write", "arguments": {"path":' }, usage, truncated: true }]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config({ modelPlan: { toolMode: 'json-in-text' } }), { client: client as never, tools: [] }, [{ role: 'user', content: 'build a game' }])) events.push(event);
    expect(events).toEqual(expect.arrayContaining([{ type: 'output_limit', turn: 1, droppedToolCalls: 0, continuing: false }]));
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('leaves complete replies alone', async () => {
    const client = scriptedClient([{ message: { role: 'assistant', content: 'All done.' }, usage }]);
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config(), { client: client as never, tools: [] }, [{ role: 'user', content: 'hi' }])) events.push(event);
    expect(events.some((e) => e.type === 'output_limit')).toBe(false);
    expect(client.chat).toHaveBeenCalledTimes(1);
  });
});
