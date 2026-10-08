import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import { DeferredToolSet, TOOL_SEARCH_NAME, createToolSearchTool, planInitialTools, planInitialToolsForConversation, resolveToolLoadingMode, shouldDeferTools } from './toolLoading';
import type { LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const tool = (name: string, description: string, required: string[] = []): Tool => ({
  name,
  description,
  parameters: { type: 'object', properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])), required },
  isReadOnly: true,
  execute: jest.fn(async (input: Record<string, unknown>) => ({ success: true, output: `${name} ran with ${JSON.stringify(input)}` })),
});

const catalogue = (): Tool[] => [
  tool('file_read', 'Read a file', ['path']),
  tool('web_search', 'Search the web'),
  tool('calendar_read', 'Read calendar events for a date range', ['from']),
  tool('email_send', 'Send an email message to a recipient', ['to', 'body']),
  tool('shopping_list', 'Manage the shopping list'),
];

describe('tool loading helpers', () => {
  it('resolves the mode and when to defer', () => {
    expect(resolveToolLoadingMode(undefined)).toBe('off');
    expect(resolveToolLoadingMode('Deferred')).toBe('deferred');
    expect(resolveToolLoadingMode('auto')).toBe('auto');
    expect(shouldDeferTools('off', 50_000, 8_000)).toBe(false);
    expect(shouldDeferTools('deferred', 10, 100_000)).toBe(true);
    expect(shouldDeferTools('auto', 10_000, 32_000)).toBe(true);
    expect(shouldDeferTools('auto', 10_000, 128_000)).toBe(false);
  });

  it('offers core tools plus the most relevant others, in registration order', () => {
    expect(planInitialTools(catalogue(), 'what is on my calendar this week', { core: ['file_read', 'web_search'], relevant: 1 }))
      .toEqual(['file_read', 'web_search', 'calendar_read']);
  });

  it('only grows the offered set over a conversation', () => {
    const core = { core: ['file_read', 'web_search'] };
    const first = planInitialToolsForConversation(catalogue(), ['what is on my calendar this week'], core);
    const second = planInitialToolsForConversation(catalogue(), ['what is on my calendar this week', 'send an email to Sam'], core);
    const third = planInitialToolsForConversation(catalogue(), ['what is on my calendar this week', 'send an email to Sam', 'thanks'], core);
    expect(first).toEqual(['file_read', 'web_search', 'calendar_read']);
    expect(second).toEqual(['file_read', 'web_search', 'calendar_read', 'email_send']);
    expect(third).toEqual(second);
  });

  it('searches deferred tools by exact name or relevance, and only grows', () => {
    const set = new DeferredToolSet(catalogue(), ['file_read', 'web_search']);
    expect(set.search('email_send').map((t) => t.name)).toEqual(['email_send']);
    expect(set.search('send an email').map((t) => t.name)[0]).toBe('email_send');
    expect(set.load(['email_send', 'file_read', 'nope'])).toEqual(['email_send']);
    expect(set.loadedNames).toEqual(['file_read', 'web_search', 'email_send']);
    expect(set.isDeferred('email_send')).toBe(false);
    expect(set.isDeferred('calendar_read')).toBe(true);
  });

  it('tool_search lists unloaded tools in its description and loads matches', async () => {
    const set = new DeferredToolSet(catalogue(), ['file_read']);
    const loaded: string[][] = [];
    const search = createToolSearchTool(set, (names) => loaded.push(names));
    expect(search.name).toBe(TOOL_SEARCH_NAME);
    expect(search.description).toContain('calendar_read');
    const result = await search.execute({ query: 'calendar events' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('calendar_read(from: string)');
    expect(loaded).toEqual([['calendar_read']]);
    expect((await search.execute({ query: 'zzz unrelated' })).success).toBe(false);
  });
});

async function run(replies: Message[], tools: Tool[]) {
  const offered: string[][] = [];
  const chat = jest.fn(async (_messages: Message[], schemas: Array<{ function: { name: string } }> = []) => {
    offered.push(schemas.map((schema) => schema.function.name));
    return { message: replies.shift() as Message };
  });
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'm', systemPrompt: 'system', maxTurns: 6, context: { enabled: false }, supervisor: false, toolLoading: { initial: ['file_read', 'web_search'] } },
    { client: { chat } as never, tools },
    [{ role: 'user', content: 'check my calendar' }],
  )) events.push(event);
  return { offered, events };
}

const call = (name: string, args: Record<string, unknown>) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }) as Message;

describe('queryLoop with deferred tool loading', () => {
  it('offers the initial set plus tool_search, then the tools it loaded', async () => {
    const tools = catalogue();
    const { offered, events } = await run([
      call('tool_search', { query: 'calendar events' }),
      call('calendar_read', { from: '2026-10-08' }),
      { role: 'assistant', content: 'You have two meetings.' } as Message,
    ], tools);
    expect(offered[0]).toEqual(['file_read', 'web_search', 'tool_search']);
    expect(offered[1]).toEqual(['file_read', 'web_search', 'calendar_read', 'tool_search']);
    expect(tools[2].execute).toHaveBeenCalledWith({ from: '2026-10-08' });
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'completed' });
  });

  it('runs a direct call to an unloaded tool when its required arguments are present', async () => {
    const tools = catalogue();
    const { offered } = await run([
      call('calendar_read', { from: '2026-10-08' }),
      { role: 'assistant', content: 'Done.' } as Message,
    ], tools);
    expect(tools[2].execute).toHaveBeenCalledTimes(1);
    expect(offered[1]).toContain('calendar_read');
  });

  it('returns the parameters instead of running an unloaded tool with missing arguments', async () => {
    const tools = catalogue();
    const { events, offered } = await run([
      call('email_send', { body: 'hi' }),
      { role: 'assistant', content: 'I need the recipient.' } as Message,
    ], tools);
    expect(tools[3].execute).not.toHaveBeenCalled();
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ result: { success: false, error: 'deferred tool called without its required parameters' } });
    expect(String((result as { result: { output: string } }).result.output)).toContain("Missing required parameter 'to'");
    expect(offered[1]).toContain('email_send');
  });
});
