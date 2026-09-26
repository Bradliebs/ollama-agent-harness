import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import type { LoopConfig, LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const makeTool = (name: string, output: string): Tool => ({
  name,
  description: name,
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  isReadOnly: true,
  execute: jest.fn(async () => ({ success: true, output })),
});

async function run(config: Partial<LoopConfig>, replies: Message[], tools: Tool[]) {
  const calls: Array<{ tools: unknown[]; options: unknown }> = [];
  const client = {
    chat: jest.fn(async (_messages: Message[], offered: unknown[] = [], _signal?: AbortSignal, options?: unknown) => {
      calls.push({ tools: offered, options });
      return { message: replies.shift() as Message };
    }),
  };
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'small-model', systemPrompt: 'system', maxTurns: 4, context: { enabled: false }, supervisor: false, ...config },
    { client: client as never, tools },
    [{ role: 'user', content: 'weather in Faro?' }],
  )) events.push(event);
  return { calls, events };
}

describe('queryLoop model plan (capability adapter)', () => {
  it('offers only the planned tools in native mode', async () => {
    const weather = makeTool('get_weather', 'sunny');
    const other = makeTool('unused_tool', 'x');
    const { calls } = await run(
      { modelPlan: { toolMode: 'native', toolNames: ['get_weather'] } },
      [{ role: 'assistant', content: 'It is sunny.' }],
      [weather, other],
    );
    expect((calls[0].tools as Array<{ function: { name: string } }>).map((schema) => schema.function.name)).toEqual(['get_weather']);
  });

  it('lifts JSON tool calls from text for json-in-text models and sends no native tools', async () => {
    const weather = makeTool('get_weather', 'sunny, 24C');
    const { calls, events } = await run(
      { modelPlan: { toolMode: 'json-in-text', toolNames: ['get_weather'] } },
      [
        { role: 'assistant', content: '{"tool_call":{"name":"get_weather","arguments":{"city":"Faro"}}}' },
        { role: 'assistant', content: 'Faro is sunny, 24C.' },
      ],
      [weather],
    );
    expect(calls[0].tools).toEqual([]);
    expect(calls[0].options).toBeUndefined();
    expect(weather.execute).toHaveBeenCalledWith({ city: 'Faro' });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: { success: true, output: 'sunny, 24C' } });
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'completed' });
  });

  it('passes the JSON schema format for constrained-json models', async () => {
    const weather = makeTool('get_weather', 'rain');
    const format = { type: 'object', properties: { tool_call: { type: 'object' } } };
    const { calls } = await run(
      { modelPlan: { toolMode: 'constrained-json', toolNames: ['get_weather'], format } },
      [
        { role: 'assistant', content: '{"tool_call":{"name":"get_weather","arguments":{"city":"Faro"}}}' },
        { role: 'assistant', content: 'Rain in Faro.' },
      ],
      [weather],
    );
    expect(calls[0]).toEqual({ tools: [], options: { format } });
    expect(weather.execute).toHaveBeenCalledTimes(1);
  });

  it('leaves plain text answers alone in prompt tool modes', async () => {
    const weather = makeTool('get_weather', 'rain');
    const { events } = await run(
      { modelPlan: { toolMode: 'json-in-text' } },
      [{ role: 'assistant', content: 'I already know: it is warm in Faro.' }],
      [weather],
    );
    expect(weather.execute).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'text')).toMatchObject({ content: 'I already know: it is warm in Faro.' });
  });
});
