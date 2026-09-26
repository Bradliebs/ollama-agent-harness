import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Message } from 'ollama';
import { queryLoop } from '../core/queryLoop';
import type { IChatClient } from '../core/chatClient';
import { RunLog, readRunEvents } from '../persistence/runLog';
import type { Tool } from '../types';
import { benchmarkHistory, compareRuns, formatReportMarkdown, formatReportTable, loadReplayCase, replayRun } from './replay';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

function call(name: string, args: Record<string, unknown>) {
  return { function: { name, arguments: args } };
}

function scriptedClient(model: string, responses: Message[], usage = { promptTokens: 10, completionTokens: 5, totalDurationNs: 2_000_000 }): IChatClient & { sent: Message[][] } {
  const sent: Message[][] = [];
  return {
    sent,
    chat: jest.fn(async (messages: Message[]) => {
      sent.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      const message = responses.shift() ?? { role: 'assistant', content: 'fallback final' } as Message;
      return { message, usage };
    }),
    chatOnce: jest.fn(),
    chatStream: jest.fn(),
    listModels: jest.fn(async () => [model]),
    getContextWindow: jest.fn(async () => null),
    healthCheck: jest.fn(async () => ({ ok: true })),
    getModel: () => model,
  } as unknown as IChatClient & { sent: Message[][] };
}

function lookupTool(counter: { count: number }): Tool {
  return {
    name: 'lookup',
    description: 'lookup fixture',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    isReadOnly: true,
    execute: async (input) => {
      counter.count += 1;
      if (input.q === 'bad') return { success: false, output: 'lookup failed', error: 'bad query' };
      return { success: true, output: `recorded:${String(input.q)}` };
    },
  };
}

async function recordRun(dir: string, runId: string, user = 'research alpha'): Promise<{ toolCounter: { count: number } }> {
  const toolCounter = { count: 0 };
  const client = scriptedClient('original-model', [
    { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'alpha' })] } as Message,
    { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'beta' })] } as Message,
    { role: 'assistant', content: 'Final answer https://example.com/source' } as Message,
  ]);
  const runLog = new RunLog(dir, runId);
  for await (const _event of queryLoop(
    { model: 'original-model', systemPrompt: 'system prompt', maxTurns: 6, context: { enabled: false }, supervisor: false },
    { client, tools: [lookupTool(toolCounter)], runLog },
    [{ role: 'user', content: user }],
  )) { /* consume */ }
  await runLog.flush();
  return { toolCounter };
}

function webReadTool(): Tool {
  return {
    name: 'web_read',
    description: 'read',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    isReadOnly: true,
    execute: async () => ({ success: true, output: 'Fujifilm X100VI: best price £1,669.28, used from £1,636.' }),
  };
}

describe('history replay', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-replay-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads the original prompt, tools, ordered recorded results and metrics', async () => {
    await recordRun(dir, 'chat-load-1');

    const replayCase = await loadReplayCase(dir, 'chat-load-1');

    expect(replayCase.systemPrompt).toBe('system prompt');
    expect(replayCase.initialMessages).toEqual([{ role: 'user', content: 'research alpha' }]);
    expect(replayCase.tools.map((tool) => tool.name)).toEqual(['lookup']);
    expect(replayCase.toolResults.map((result) => [result.name, result.input, result.output])).toEqual([
      ['lookup', { q: 'alpha' }, 'recorded:alpha'],
      ['lookup', { q: 'beta' }, 'recorded:beta'],
    ]);
    expect(Object.keys(replayCase.toolResultsByKey)).toHaveLength(2);
    expect(replayCase.originalMetrics).toMatchObject({
      doneReason: 'completed',
      turns: 3,
      toolCalls: 2,
      toolFailures: 0,
      promptTokens: 30,
      completionTokens: 15,
      citedSources: 1,
      completed: true,
    });
  });

  it('scores figure claims in the final answer against the pages read, for the original and each replay', async () => {
    const runLog = new RunLog(dir, 'chat-claims-1');
    const original = scriptedClient('original-model', [
      { role: 'assistant', content: '', tool_calls: [call('web_read', { url: 'https://prices.example/x100vi' })] } as Message,
      { role: 'assistant', content: 'It is £1,669.28 new and £1,636 used; the black one is £1,799.' } as Message,
    ]);
    for await (const _event of queryLoop(
      { model: 'original-model', systemPrompt: 'system prompt', maxTurns: 4, context: { enabled: false }, supervisor: false },
      { client: original, tools: [webReadTool()], runLog },
      [{ role: 'user', content: 'What does the X100VI cost?' }],
    )) { /* consume */ }
    await runLog.flush();
    const replayCase = await loadReplayCase(dir, 'chat-claims-1');
    expect(replayCase.originalMetrics).toMatchObject({ checkedClaims: 1, unsupportedClaims: 1 });

    const replay = await replayRun(replayCase, {
      model: 'careful-model',
      client: scriptedClient('careful-model', [
        { role: 'assistant', content: '', tool_calls: [call('web_read', { url: 'https://prices.example/x100vi' })] } as Message,
        { role: 'assistant', content: 'It is £1,669.28 new and £1,636 used.' } as Message,
      ]),
    });
    expect(replay.metrics).toMatchObject({ checkedClaims: 1, unsupportedClaims: 0 });
    expect(formatReportTable(compareRuns(replayCase.originalMetrics, [replay.metrics]))).toMatch(/unsupported[\s\S]*1\/1[\s\S]*0\/1/);
  });

  it('deterministically replays exact, approximate and missing tool results without executing original tools', async () => {
    const { toolCounter } = await recordRun(dir, 'chat-replay-1');
    const originalToolCalls = toolCounter.count;
    const replayCase = await loadReplayCase(dir, 'chat-replay-1');
    const client = scriptedClient('new-model', [
      { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'alpha' })] } as Message,
      { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'gamma' })] } as Message,
      { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'delta' })] } as Message,
      { role: 'assistant', content: 'Replay final' } as Message,
    ], { promptTokens: 4, completionTokens: 2, totalDurationNs: 1_000_000 });

    const replay = await replayRun(replayCase, { client, model: 'new-model', maxTurns: 6, now: new Date('2026-01-02T03:04:05Z') });

    expect(toolCounter.count).toBe(originalToolCalls);
    expect(replay.runId).toContain('replay-chat-replay-1-new-model-20260102030405');
    expect(replay.metrics).toMatchObject({
      doneReason: 'completed',
      toolCalls: 3,
      toolFailures: 1,
      approximateToolMatches: 1,
      missingToolResults: 1,
      promptTokens: 16,
      completionTokens: 8,
      finalText: 'Replay final',
    });
    const sentToolOutputs = client.sent.flatMap((messages) => messages.filter((message) => message.role === 'tool').map((message) => message.content));
    expect(sentToolOutputs).toEqual(expect.arrayContaining(['recorded:alpha', 'recorded:beta', 'No recorded result for this call in the original run (replay mode)']));
    const replayEvents = await readRunEvents(dir, replay.runId);
    expect(replayEvents[0]).toMatchObject({ kind: 'run_start', data: { model: 'new-model' } });
  });

  it('lends real tool schemas to replay stubs without ever executing the real tool', async () => {
    await recordRun(dir, 'chat-schema-1');
    const replayCase = await loadReplayCase(dir, 'chat-schema-1');
    const realExecute = jest.fn();
    const real: Tool = {
      name: 'lookup',
      description: 'Real lookup description from the tool registry',
      parameters: { type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
      isReadOnly: false,
      execute: realExecute,
    };
    const offered: unknown[][] = [];
    const client = scriptedClient('schema-model', [
      { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'alpha' })] } as Message,
      { role: 'assistant', content: 'done' } as Message,
    ]);
    const baseChat = client.chat;
    client.chat = jest.fn(async (messages: Message[], tools?: unknown[]) => {
      offered.push(tools ?? []);
      return baseChat(messages);
    }) as never;

    await replayRun(replayCase, { client, model: 'schema-model', schemaTools: [real] });

    expect(realExecute).not.toHaveBeenCalled();
    expect(offered[0]).toEqual([expect.objectContaining({ function: expect.objectContaining({
      name: 'lookup',
      description: 'Real lookup description from the tool registry',
      parameters: expect.objectContaining({ required: ['q'] }),
    }) })]);
  });

  it('compares runs and formats text and Markdown reports', async () => {
    await recordRun(dir, 'chat-compare-1');
    const replayCase = await loadReplayCase(dir, 'chat-compare-1');
    const replayMetrics = { ...replayCase.originalMetrics, runId: 'replay', model: 'm2', turns: replayCase.originalMetrics.turns + 1 };

    const report = compareRuns(replayCase.originalMetrics, [replayMetrics]);

    expect(report.rows[0].turnsDelta).toBe(1);
    expect(formatReportTable(report)).toContain('original');
    expect(formatReportTable(report)).toContain('m2');
    expect(formatReportMarkdown(report)).toContain('| Run | Done |');
  });

  it('benchmarks the last completed tool-using chat runs across models', async () => {
    await recordRun(dir, 'chat-bench-1', 'one');
    await recordRun(dir, 'chat-bench-2', 'two');
    const report = await benchmarkHistory(dir, {
      models: ['m1', 'm2'],
      lastN: 2,
      createClient: (model) => scriptedClient(model, [
        { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'alpha' })] } as Message,
        { role: 'assistant', content: `${model} done https://example.com/${model}` } as Message,
      ], { promptTokens: 3, completionTokens: 2, totalDurationNs: 1_000_000 }),
    });

    expect(report.selectedRunIds).toHaveLength(2);
    expect(report.rows).toHaveLength(4);
    expect(report.aggregates).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'm1', runs: 2, completionRate: 1, avgTokens: 10, avgCitedSources: 1 }),
      expect.objectContaining({ model: 'm2', runs: 2, completionRate: 1, avgTokens: 10, avgCitedSources: 1 }),
    ]));
  });
});
