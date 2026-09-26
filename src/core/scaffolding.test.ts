import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import { NEXT_STEP_PROMPT, PLAN_ACCEPTED_PROMPT, SKIPPED_EXTRA_CALL, rankToolsByRelevance, resolveScaffoldLevel, scaffoldFor, selectRelevantTools, trimToolResult } from './scaffolding';
import type { LoopConfig, LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const tool = (name: string, description: string, output = `${name} result`): Tool => ({
  name,
  description,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  isReadOnly: true,
  execute: jest.fn(async (input: Record<string, unknown>) => ({ success: true, output: `${output} ${String(input.q ?? '')}`.trim() })),
});

const call = (name: string, q: string) => ({ function: { name, arguments: { q } } });

describe('scaffolding helpers', () => {
  it('resolves the level from mode and profile', () => {
    expect(resolveScaffoldLevel(undefined, 'heavy')).toBeNull();
    expect(resolveScaffoldLevel('off', 'heavy')).toBeNull();
    expect(resolveScaffoldLevel('profile', 'heavy')).toBe('heavy');
    expect(resolveScaffoldLevel('profile', undefined)).toBeNull();
    expect(resolveScaffoldLevel('Medium', 'light')).toBe('medium');
  });

  it('ranks and selects tools by relevance, keeping required tools', () => {
    const tools = [
      tool('file_write', 'Write a file'),
      tool('web_search', 'Search the web for pages'),
      tool('web_read', 'Read a web page'),
      { ...tool('state_update', 'Update working state'), required: true },
    ];
    const scores = rankToolsByRelevance(tools, 'search the web for camera prices');
    expect(scores.get('web_search')).toBeGreaterThan(scores.get('file_write') ?? 0);
    expect(selectRelevantTools(tools, 'search the web for camera prices', 2).map((t) => t.name)).toEqual(['web_search', 'state_update']);
    expect(selectRelevantTools(tools, 'anything', 0)).toHaveLength(4);
  });

  it('trims older tool results to a short marker', () => {
    expect(trimToolResult(`a\n\n${'x'.repeat(500)}`)).toMatch(/^\[older tool result trimmed to keep context narrow: a x{198}…\]$/);
  });
});

async function run(config: Partial<LoopConfig>, replies: Message[], tools: Tool[]) {
  const sent: Message[][] = [];
  const client = {
    chat: jest.fn(async (messages: Message[]) => {
      sent.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      return { message: replies.shift() as Message };
    }),
  };
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'small-model', systemPrompt: 'system', maxTurns: 8, context: { enabled: false }, supervisor: false, ...config },
    { client: client as never, tools },
    [{ role: 'user', content: 'compare camera prices' }],
  )) events.push(event);
  return { sent, events };
}

describe('queryLoop with scaffolding', () => {
  it('heavy: takes the first reply as the plan, runs one tool per step, prompts the next step and narrows context', async () => {
    const search = tool('web_search', 'search', 'results for');
    const { sent, events } = await run({ scaffold: { ...scaffoldFor('heavy'), keepRecentToolResults: 1 } }, [
      { role: 'assistant', content: '1. search prices 2. read page 3. answer' },
      { role: 'assistant', content: '', tool_calls: [call('web_search', 'x100vi price'), call('web_search', 'ignored extra')] } as Message,
      { role: 'assistant', content: '', tool_calls: [call('web_search', 'zr price')] } as Message,
      { role: 'assistant', content: 'X100VI £1,669; ZR £1,999.' },
    ], [search]);

    expect(String(sent[0][0].content)).toContain('First reply with ONLY a numbered plan');
    expect(sent[1][sent[1].length - 1]).toMatchObject({ role: 'user', content: PLAN_ACCEPTED_PROMPT });
    expect(search.execute).toHaveBeenCalledTimes(2);
    const skipped = events.find((event) => event.type === 'tool_result' && event.result.error === 'scaffold: extra tool call skipped');
    expect(skipped).toMatchObject({ result: { output: SKIPPED_EXTRA_CALL } });
    expect(sent[2].some((m) => m.role === 'user' && m.content === NEXT_STEP_PROMPT)).toBe(true);
    // By the last call only the most recent tool result is kept in full.
    const toolMessages = sent[3].filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(toolMessages.slice(0, -1).every((content) => content.startsWith('[older tool result trimmed'))).toBe(true);
    expect(toolMessages[toolMessages.length - 1]).toBe('results for zr price');
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'completed' });
  });

  it('medium: caps tool calls per turn at three and does not treat the first answer as a plan', async () => {
    const search = tool('web_search', 'search');
    const { events } = await run({ scaffold: scaffoldFor('medium') }, [
      { role: 'assistant', content: '', tool_calls: [call('web_search', 'a'), call('web_search', 'b'), call('web_search', 'c'), call('web_search', 'd')] } as Message,
      { role: 'assistant', content: 'done' },
    ], [search]);
    expect(search.execute).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === 'tool_result' && event.result.error === 'scaffold: extra tool call skipped')).toHaveLength(1);
  });

  it('no scaffold: a text-only first reply ends the run as before', async () => {
    const { events } = await run({}, [{ role: 'assistant', content: 'Direct answer.' }], [tool('web_search', 'search')]);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'completed' });
    expect(events.some((event) => event.type === 'auto_continue')).toBe(false);
  });
});
