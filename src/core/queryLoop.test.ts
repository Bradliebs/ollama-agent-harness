import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import { detectPartialResult } from './queryLoop';
import { RuntimeTracer } from './tracing';
import type { LoopConfig, Tool, ToolCall, ToolResult } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    model: 'test-model',
    systemPrompt: 'system',
    maxTurns: 3,
    context: { enabled: false },
    ...overrides,
  };
}

function makeClient(messages: Message[]) {
  return {
    chat: jest.fn().mockImplementation(async () => ({ message: messages.shift() })),
  };
}

function makeTool(
  name: string,
  isReadOnly: boolean,
  execute: (input: Record<string, unknown>) => Promise<ToolResult>,
): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    isReadOnly,
    execute,
  };
}

async function collectEvents(client: ReturnType<typeof makeClient>, tools: Tool[], options: {
  config?: Partial<LoopConfig>;
  permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>;
  hooks?: { execute: jest.Mock };
  session?: Record<string, jest.Mock>;
  tracer?: RuntimeTracer;
  initialMessages?: Message[];
} = {}) {
  const events = [];
  for await (const event of queryLoop(
    makeConfig(options.config),
    {
      client: client as never,
      tools,
      permissionCheck: options.permissionCheck,
      hooks: options.hooks as never,
      session: options.session as never,
      summarizerClient: client as never,
      tracer: options.tracer,
    },
    options.initialMessages ?? [{ role: 'user', content: 'hello' }],
  )) {
    events.push(event);
  }
  return events;
}

describe('queryLoop runtime behavior', () => {
  it('emits text and completes for a text-only model response', async () => {
    const client = makeClient([{ role: 'assistant', content: 'All done.' }]);

    const events = await collectEvents(client, []);

    expect(events.map((event) => event.type)).toEqual(['turn_complete', 'text', 'done']);
    expect(events[1]).toEqual({ type: 'text', content: 'All done.' });
  });

  it('emits output validation before final text when validation is enabled', async () => {
    const client = makeClient([{ role: 'assistant', content: 'All done.' }]);

    const events = await collectEvents(client, [], {
      config: { outputValidation: { enabled: true, profile: 'oracle-prime' } },
    });

    expect(events.map((event) => event.type)).toEqual(['output_validation', 'turn_complete', 'text', 'done']);
    expect(events[0]).toMatchObject({
      type: 'output_validation',
      validation: { profile: 'oracle-prime', status: 'fail' },
    });
  });

  it('reports reason "completed_with_validation_failures" when validation fails', async () => {
    // Without this, the "fail" finding is silently overwritten by reason:
    // "completed" and the user has no machine-readable signal that the
    // validator rejected the final response.
    const client = makeClient([{ role: 'assistant', content: 'All done.' }]);

    const events = await collectEvents(client, [], {
      config: { outputValidation: { enabled: true, profile: 'oracle-prime' } },
    });

    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual(expect.objectContaining({
      type: 'done',
      reason: 'completed_with_validation_failures',
    }));
  });

  it('reports reason "completed" when validation passes', async () => {
    // tool-result-summary is the most permissive built-in profile; a
    // simple outcome-bearing summary should pass it cleanly.
    const client = makeClient([{
      role: 'assistant',
      content: 'Success: wrote 12 lines to src/foo.ts (typecheck passed, exit code 0).',
    }]);

    const events = await collectEvents(client, [], {
      config: { outputValidation: { enabled: true, profile: 'tool-result-summary' } },
    });

    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
  });

  it('auto-promotes oracle-prime to coding-answer when productive tools succeeded', async () => {
    // Repro of the user-reported confusion: oracle-prime is the default
    // fallback profile, but applying it to a coding session that wrote
    // files produces FAIL findings for missing reasoning sections that
    // were never asked for. When the run actually edited files, swap
    // profiles automatically so the validator matches the work done.
    const fileWrite = makeTool('file_write', false, async () => ({ success: true, output: 'wrote' }));
    const client = makeClient([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'file_write', arguments: {} } }],
      } as Message,
      { role: 'assistant', content: 'Edited src/foo.ts and ran typecheck — no errors.' },
    ]);

    const events = await collectEvents(client, [fileWrite], {
      config: { outputValidation: { enabled: true, profile: 'oracle-prime' } },
    });

    const validation = events.find((e) => e.type === 'output_validation');
    expect(validation).toMatchObject({
      type: 'output_validation',
      validation: { profile: 'coding-answer' },
    });
    // Promotion event must precede the validation event so UIs can
    // explain the swap before the validation result lands.
    const promotion = events.find((e) => e.type === 'output_validation_profile_promoted');
    expect(promotion).toMatchObject({
      type: 'output_validation_profile_promoted',
      from: 'oracle-prime',
      to: 'coding-answer',
    });
    expect(events.indexOf(promotion as never)).toBeLessThan(events.indexOf(validation as never));
  });

  it('preserves provider tool call ids on tool result messages', async () => {
    const echo = makeTool('echo', true, async () => ({ success: true, output: 'echoed' }));
    const client = makeClient([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_mistral_abc', function: { name: 'echo', arguments: {} } } as never],
      } as Message,
      { role: 'assistant', content: 'done' },
    ]);

    await collectEvents(client, [echo]);

    const secondCallMessages = client.chat.mock.calls[1][0] as Message[];
    const toolMessage = secondCallMessages.find((message) => message.role === 'tool') as Message & { tool_call_id?: string };
    expect(toolMessage.tool_call_id).toBe('call_mistral_abc');
  });

  it('does NOT auto-promote when no productive tools fired', async () => {
    // A pure Q&A turn with oracle-prime should still validate against
    // oracle-prime — auto-promotion is for runs that did real edits.
    const client = makeClient([{ role: 'assistant', content: 'A short answer.' }]);

    const events = await collectEvents(client, [], {
      config: { outputValidation: { enabled: true, profile: 'oracle-prime' } },
    });

    const validation = events.find((e) => e.type === 'output_validation');
    expect(validation).toMatchObject({
      type: 'output_validation',
      validation: { profile: 'oracle-prime' },
    });
    // No promotion event when nothing fired.
    expect(events.find((e) => e.type === 'output_validation_profile_promoted')).toBeUndefined();
  });

  it('auto-promotes oracle-prime to tool-result-summary when non-file tools succeeded', async () => {
    const browserNavigate = makeTool('browser_navigate', true, async () => ({ success: true, output: 'Cloudflare page loaded' }));
    const client = makeClient([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'browser_navigate', arguments: { url: 'https://example.test' } } }],
      } as Message,
      { role: 'assistant', content: 'Browser navigation completed, but the page showed Cloudflare blocking content.' },
    ]);

    const events = await collectEvents(client, [browserNavigate], {
      config: { outputValidation: { enabled: true, profile: 'oracle-prime' } },
    });

    expect(events.find((e) => e.type === 'output_validation_profile_promoted')).toMatchObject({
      type: 'output_validation_profile_promoted',
      from: 'oracle-prime',
      to: 'tool-result-summary',
    });
    expect(events.find((e) => e.type === 'output_validation')).toMatchObject({
      type: 'output_validation',
      validation: { profile: 'tool-result-summary' },
    });
  });

  it('pairs enabled output validation with profile instructions in the system prompt', async () => {
    const client = makeClient([{ role: 'assistant', content: 'Implemented changes in src/core/queryLoop.ts and ran tests.' }]);

    await collectEvents(client, [], {
      config: { outputValidation: { enabled: true, profile: 'coding-answer' } },
    });

    expect(client.chat.mock.calls[0][0][0]).toMatchObject({ role: 'system' });
    expect(client.chat.mock.calls[0][0][0].content).toContain('Output validation profile: coding-answer');
  });

  it('uses custom output validation profiles when configured', async () => {
    const client = makeClient([{ role: 'assistant', content: 'Release validation passed.' }]);

    const events = await collectEvents(client, [], {
      config: { outputValidation: { enabled: true, profile: 'release-note', customProfiles: [{ profile: 'release-note', label: 'Release Note', description: 'Release validation summary.', instructions: 'Mention release validation.', checks: [{ code: 'missing-release', severity: 'fail', message: 'Mention release.', requiresAll: ['release'] }] }] } },
    });

    expect(client.chat.mock.calls[0][0][0].content).toContain('Mention release validation.');
    expect(events[0]).toMatchObject({ type: 'output_validation', validation: { profile: 'release-note', status: 'pass' } });
  });

  it('dispatches tool calls through the shared dispatcher and continues', async () => {
    const tool = makeTool('echo', true, async (input) => ({ success: true, output: `echo:${input.value}` }));
    const client = makeClient([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { value: 'x' } } }] },
      { role: 'assistant', content: 'Done after tool.' },
    ]);

    const events = await collectEvents(client, [tool]);

    expect(events.map((event) => event.type)).toEqual(['tool_call', 'tool_result', 'turn_complete', 'turn_complete', 'text', 'done']);
    expect(events[1]).toMatchObject({ type: 'tool_result', result: { success: true, output: 'echo:x' } });
  });

  it('skips repeated blocked web reads and asks the model to choose another source', async () => {
    const webRead = makeTool('web_read', true, jest.fn().mockResolvedValue({ success: false, output: 'HTTP 401 Unauthorized', error: 'HTTP 401' }));
    const blockedUrl = 'https://example.test/paywalled-story';
    const client = makeClient([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_read', arguments: { url: blockedUrl } } }] } as Message,
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_read', arguments: { url: blockedUrl } } }] } as Message,
      { role: 'assistant', content: 'Used another source instead.' },
    ]);

    const events = await collectEvents(client, [webRead], { config: { maxTurns: 5 } });

    expect(webRead.execute).toHaveBeenCalledTimes(1);
    const repeatedResult = events.find((event) => event.type === 'tool_result' && 'result' in event && String(event.result.output).includes('Skipped repeated web_read'));
    expect(repeatedResult).toMatchObject({
      type: 'tool_result',
      result: { success: false, error: 'repeated blocked URL' },
    });
    expect(events.find((event) => event.type === 'text')).toMatchObject({ content: 'Used another source instead.' });
  });

  it('returns permission denial as a tool result', async () => {
    const tool = makeTool('write', false, async () => ({ success: true, output: 'should not run' }));
    const client = makeClient([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write', arguments: {} } }] },
      { role: 'assistant', content: 'Handled denial.' },
    ]);

    const events = await collectEvents(client, [tool], {
      permissionCheck: async () => ({ allowed: false, reason: 'no writes' }),
    });

    expect(events[1]).toMatchObject({ type: 'tool_result', result: { success: false } });
    expect((events[1] as { result: ToolResult }).result.output).toContain('Permission denied');
  });

  it('warns but continues after repeated failures from the same tool', async () => {
    const documentExport = makeTool('document_export', false, async () => ({ success: false, output: 'Failed to write docx: bad content', error: 'bad content' }));
    const client = makeClient([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'document_export', arguments: {} } }] } as Message,
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'document_export', arguments: {} } }] } as Message,
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'document_export', arguments: {} } }] } as Message,
      { role: 'assistant', content: 'recovered after warning' },
    ]);

    const events = await collectEvents(client, [documentExport], {
      config: { maxTurns: 10, repeatedToolFailureLimit: 3 },
    });

    const error = events.find((e) => e.type === 'error');
    expect(error).toEqual(expect.objectContaining({
      type: 'error',
      recoverable: true,
      message: expect.stringContaining('document_export has failed 3 times'),
    }));
    // Loop should continue, not stop — model can try different tools
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
    const text = events.find((e) => e.type === 'text');
    expect(text).toMatchObject({ content: 'recovered after warning' });
  });

  it('can disable the repeated tool failure breaker', async () => {
    const flaky = makeTool('flaky', false, async () => ({ success: false, output: 'still failing' }));
    const client = makeClient([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'flaky', arguments: {} } }] } as Message,
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'flaky', arguments: {} } }] } as Message,
      { role: 'assistant', content: 'reported failure' },
    ]);

    const events = await collectEvents(client, [flaky], {
      config: { maxTurns: 5, repeatedToolFailureLimit: 0 },
    });

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toEqual(expect.objectContaining({ reason: 'completed' }));
  });

  it('applies hook input and output mutations during dispatch', async () => {
    const tool = makeTool('echo', false, async (input) => ({ success: true, output: `tool:${input.value}` }));
    const hooks = {
      execute: jest.fn()
        .mockResolvedValueOnce({ modifiedInput: { value: 'hooked' } })
        .mockResolvedValueOnce({ modifiedOutput: 'post-hooked' }),
    };
    const client = makeClient([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { value: 'raw' } } }] },
      { role: 'assistant', content: 'Done.' },
    ]);

    const events = await collectEvents(client, [tool], { hooks });

    expect(events[0]).toMatchObject({ type: 'tool_call', call: { input: { value: 'hooked' } } });
    expect(events[1]).toMatchObject({ type: 'tool_result', result: { output: 'post-hooked' } });
  });

  it('autosaves loop events to session storage', async () => {
    const tool = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
    const session = {
      markStatus: jest.fn().mockResolvedValue(undefined),
      append: jest.fn().mockResolvedValue(undefined),
      getSessionId: jest.fn().mockReturnValue('session-1'),
    };
    const client = makeClient([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: {} } }] },
      { role: 'assistant', content: 'Done.' },
    ]);

    await collectEvents(client, [tool], { session });

    expect(session.markStatus).toHaveBeenCalledWith('running', undefined);
    expect(session.markStatus).toHaveBeenCalledWith('completed', undefined);
    expect(session.append.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
    ]));
  });

  it('emits context events when compaction runs', async () => {
    const longMessage = 'Implement continuity checkpoints for queryLoop.test.ts '.repeat(80);
    const client = makeClient([
      { role: 'assistant', content: 'continuity checkpoints queryLoop.test.ts' },
      { role: 'assistant', content: 'Done.' },
    ]);

    const events = await collectEvents(client, [], {
      config: {
        context: {
          maxTokens: 100,
          budgetPerToolResult: 4000,
          snipThreshold: 0.7,
          autoCompactThreshold: 0.85,
          minSummaryQuality: 0,
        },
      },
      initialMessages: [
        { role: 'user', content: longMessage },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Another earlier request' },
        { role: 'user', content: 'Latest request' },
      ],
    });

    expect(events[0]).toMatchObject({ type: 'context', strategy: 'auto_compact', autosaved: false });
    expect(events.map((event) => event.type)).toContain('text');
  });

  it('emits a context breakdown when the prompt approaches the configured budget', async () => {
    const client = makeClient([{ role: 'assistant', content: 'Done.' }]);

    const events = await collectEvents(client, [], {
      config: { context: { enabled: false, maxTokens: 40 } },
      initialMessages: [{ role: 'user', content: 'hello '.repeat(40) }],
    });

    expect(events.find((event) => event.type === 'context_breakdown')).toMatchObject({
      type: 'context_breakdown',
      maxTokens: 40,
      currentUserTokens: expect.any(Number),
      totalTokens: expect.any(Number),
    });
  });

  it('records model and session trace records when tracing is enabled', async () => {
    const tracer = new RuntimeTracer();
    const session = {
      markStatus: jest.fn().mockResolvedValue(undefined),
      append: jest.fn().mockResolvedValue(undefined),
      getSessionId: jest.fn().mockReturnValue('session-1'),
    };
    const client = makeClient([{ role: 'assistant', content: 'All done.' }]);

    await collectEvents(client, [], { session, tracer });

    const snapshot = tracer.snapshot();
    expect(snapshot.spans).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'model.chat', status: 'ok' })]));
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'session.status' }),
      expect.objectContaining({ name: 'session.append' }),
    ]));
  });

  describe('unproductiveTurnLimit', () => {
    function makeToolCallMessage(name: string): Message {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name, arguments: {} } }],
      } as Message;
    }

    it('terminates with reason "unproductive" after N consecutive non-edit turns', async () => {
      const reflect = makeTool('reflect', false, async () => ({ success: true, output: 'noted' }));
      const client = makeClient([
        makeToolCallMessage('reflect'),
        makeToolCallMessage('reflect'),
        makeToolCallMessage('reflect'),
      ]);

      const events = await collectEvents(client, [reflect], {
        config: { maxTurns: 10, unproductiveTurnLimit: 3 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'unproductive' }));
      const error = events.find((e) => e.type === 'error');
      expect(error).toEqual(expect.objectContaining({ recoverable: false, message: expect.stringContaining('without file edits') }));
    });

    it('resets the unproductive counter when file_edit succeeds', async () => {
      const reflect = makeTool('reflect', false, async () => ({ success: true, output: 'noted' }));
      const fileEdit = makeTool('file_edit', false, async () => ({ success: true, output: 'edited' }));
      const client = makeClient([
        makeToolCallMessage('reflect'),
        makeToolCallMessage('reflect'),
        makeToolCallMessage('file_edit'),
        makeToolCallMessage('reflect'),
        { role: 'assistant', content: 'finished' },
      ]);

      const events = await collectEvents(client, [reflect, fileEdit], {
        config: { maxTurns: 10, unproductiveTurnLimit: 3 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
    });

    it('does not trigger when unproductiveTurnLimit is unset', async () => {
      const reflect = makeTool('reflect', false, async () => ({ success: true, output: 'noted' }));
      const client = makeClient([
        makeToolCallMessage('reflect'),
        makeToolCallMessage('reflect'),
        { role: 'assistant', content: 'done' },
      ]);

      const events = await collectEvents(client, [reflect], {
        config: { maxTurns: 5 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
    });

    it('does not count failed file_edit calls as productive', async () => {
      const fileEdit = makeTool('file_edit', false, async () => ({ success: false, output: 'failed', error: 'boom' }));
      const client = makeClient([
        makeToolCallMessage('file_edit'),
        makeToolCallMessage('file_edit'),
      ]);

      const events = await collectEvents(client, [fileEdit], {
        config: { maxTurns: 10, unproductiveTurnLimit: 2 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'unproductive' }));
    });
  });

  describe('bonus synthesis turn', () => {
    function makeToolCallMessage(name: string): Message {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name, arguments: {} } }],
      } as Message;
    }

    it('grants a bonus tool-stripped turn when maxTurns exhausted on tool calls', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      // 2 turns of tool calls exhaust maxTurns=2, then the bonus turn produces text.
      const client = makeClient([
        makeToolCallMessage('echo'),
        makeToolCallMessage('echo'),
        { role: 'assistant', content: 'Here is my synthesis.' },
      ]);

      const events = await collectEvents(client, [echo], {
        config: { maxTurns: 2 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'max_turns_synthesized', turns: 3 }));
      const text = events.find((e) => e.type === 'text');
      expect(text).toEqual({ type: 'text', content: 'Here is my synthesis.' });
      // The bonus turn should be called with empty tools array.
      const lastCall = client.chat.mock.calls[client.chat.mock.calls.length - 1];
      expect(lastCall[1]).toEqual([]);
      // Should emit synthesis_fired telemetry event.
      const synth = events.find((e) => e.type === 'synthesis_fired');
      expect(synth).toEqual({ type: 'synthesis_fired', model: 'test-model', maxTurns: 2, toolCallsTotal: 2 });
    });

    it('prepends a factual artifact header when the synthesis summary ignores a file it wrote', async () => {
      // Confabulation guard: the model writes a real file, then the
      // tool-stripped synthesis turn invents a "no data / it failed" summary
      // that never references the artifact. The user must not be shown the
      // hallucination as if no deliverable exists.
      const fileWrite = makeTool('file_write', false, async () => ({ success: true, output: 'Saved to: report.xlsx' }));
      const client = makeClient([
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_write', arguments: { path: 'report.xlsx', content: 'data' } } }] } as Message,
        { role: 'assistant', content: 'The query returned a header-only table with no data rows.' },
      ]);

      const events = await collectEvents(client, [fileWrite], { config: { maxTurns: 1 } });

      const text = events.find((e) => e.type === 'text') as { content: string } | undefined;
      expect(text).toBeDefined();
      // Factual header naming the real artifact is prepended...
      expect(text!.content).toContain('report.xlsx');
      expect(text!.content).toContain('does not mention');
      // ...and the model's original (wrong) text is preserved below it.
      expect(text!.content).toContain('header-only table with no data rows');
    });

    it('does not alter a synthesis summary that already names the file it wrote', async () => {
      const fileWrite = makeTool('file_write', false, async () => ({ success: true, output: 'Saved to: report.xlsx' }));
      const client = makeClient([
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_write', arguments: { path: 'report.xlsx', content: 'data' } } }] } as Message,
        { role: 'assistant', content: 'I built the dashboard and saved it to report.xlsx with all sheets populated.' },
      ]);

      const events = await collectEvents(client, [fileWrite], { config: { maxTurns: 1 } });

      const text = events.find((e) => e.type === 'text') as { content: string } | undefined;
      expect(text).toBeDefined();
      expect(text!.content).toBe('I built the dashboard and saved it to report.xlsx with all sheets populated.');
      expect(text!.content).not.toContain('does not mention');
    });

    it('routes an empty final turn into synthesis when tools ran (does not stop as completed)', async () => {
      // Regression: small local models (e.g. Gemma) sometimes run tools then
      // end the run with an empty text turn instead of writing an answer.
      // That must NOT be accepted as `completed` with empty text — it should
      // fall into the tool-stripped synthesis turn so the gathered results
      // get turned into a reply.
      const search = makeTool('web_search', true, async () => ({ success: true, output: 'Results: BBC headline, Sky headline' }));
      const client = makeClient([
        makeToolCallMessage('web_search'),
        { role: 'assistant', content: '' }, // empty final turn after tools
        { role: 'assistant', content: 'Here are the headlines I found.' }, // synthesis
      ]);

      const events = await collectEvents(client, [search], {
        config: { maxTurns: 10 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'empty_after_tools_synthesized' }));
      const text = events.find((e) => e.type === 'text');
      expect(text).toEqual({ type: 'text', content: 'Here are the headlines I found.' });
      // Synthesis turn must be called with tools stripped.
      const lastCall = client.chat.mock.calls[client.chat.mock.calls.length - 1];
      expect(lastCall[1]).toEqual([]);
      // synthesis_fired should be emitted exactly once (not double-emitted).
      const synthEvents = events.filter((e) => e.type === 'synthesis_fired');
      expect(synthEvents).toHaveLength(1);
    });

    it('does not route an empty final turn into synthesis when no tools ran', async () => {
      // An empty reply with no prior tool use is a genuinely empty model
      // response, not a dropped synthesis — keep the existing `completed`
      // behaviour so we don't burn an extra turn on a model that said nothing.
      const client = makeClient([{ role: 'assistant', content: '' }]);

      const events = await collectEvents(client, []);

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
      const synthEvents = events.filter((e) => e.type === 'synthesis_fired');
      expect(synthEvents).toHaveLength(0);
    });

    it('emits max_turns with error when synthesis turn fails', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = {
        chat: jest.fn()
          .mockResolvedValueOnce({ message: makeToolCallMessage('echo') })
          .mockRejectedValueOnce(new Error('provider down')),
      };

      const events = await collectEvents(client as ReturnType<typeof makeClient>, [echo], {
        config: { maxTurns: 1 },
      });

      const error = events.find((e) => e.type === 'error');
      expect(error).toEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('Synthesis turn failed') }));
      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'max_turns' }));
      // When the synthesis call itself throws, the loop should still
      // surface the recent tool output so the user sees the work that
      // was actually done before the provider died.
      const fallbackText = events.find((e) => e.type === 'text' && typeof (e as { content?: unknown }).content === 'string' && (e as { content: string }).content.includes('Synthesis call failed'));
      expect(fallbackText).toBeDefined();
      expect((fallbackText as { content: string }).content).toContain('ok');
    });

    it('injects a system message instructing the model to synthesize', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        makeToolCallMessage('echo'),
        { role: 'assistant', content: 'Summary.' },
      ]);

      await collectEvents(client, [echo], {
        config: { maxTurns: 1 },
      });

      // The bonus turn call should include a system message about synthesizing.
      const lastCallMessages = client.chat.mock.calls[client.chat.mock.calls.length - 1][0] as Message[];
      const synthInstruction = lastCallMessages.find(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Do NOT call any tools'),
      );
      expect(synthInstruction).toBeDefined();
    });

    it('falls back to tool results when synthesis produces empty text', async () => {
      const search = makeTool('web_search', true, async () => ({ success: true, output: 'Results: BBC News headline, CNN headline' }));
      const client = makeClient([
        makeToolCallMessage('web_search'),
        // Synthesis turn returns empty content (model tried to call tools again)
        { role: 'assistant', content: '' },
      ]);

      const events = await collectEvents(client, [search], {
        config: { maxTurns: 1 },
      });

      const text = events.find((e) => e.type === 'text');
      expect(text).toBeDefined();
      expect((text as { content: string }).content).toContain('BBC News headline');
      expect((text as { content: string }).content).toContain('what it found');
    });

    it('includes recent tool results in synthesis instruction for small models', async () => {
      const search = makeTool('web_search', true, async () => ({ success: true, output: 'Top stories: AI advances, weather update' }));
      const client = makeClient([
        makeToolCallMessage('web_search'),
        { role: 'assistant', content: 'Here is a summary of the news.' },
      ]);

      await collectEvents(client, [search], {
        config: { maxTurns: 1 },
      });

      const lastCallMessages = client.chat.mock.calls[client.chat.mock.calls.length - 1][0] as Message[];
      const synthInstruction = lastCallMessages.find(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('recent tool results'),
      );
      expect(synthInstruction).toBeDefined();
      expect((synthInstruction as Message).content).toContain('Top stories');
    });
  });

  describe('wall-clock time budget', () => {
    function makeToolCallMessage(name: string): Message {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name, arguments: {} } }],
      } as Message;
    }

    it('triggers synthesis when time budget is exceeded', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        makeToolCallMessage('echo'),
        makeToolCallMessage('echo'),
        { role: 'assistant', content: 'Here is my time-budget synthesis.' },
      ]);

      // Mock Date.now to simulate time passing beyond the budget after the first turn.
      const realNow = Date.now;
      let callCount = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        // First few calls return start time; subsequent calls return past-budget time.
        return callCount <= 2 ? realNow() : realNow() + 200_000;
      });

      try {
        const events = await collectEvents(client, [echo], {
          config: { maxTurns: 20, maxTimeMs: 180_000 },
        });

        const done = events.find((e) => e.type === 'done');
        expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'time_budget_synthesized' }));
        const synth = events.find((e) => e.type === 'synthesis_fired');
        expect(synth).toBeDefined();
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('does not trigger when time budget is unset', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        makeToolCallMessage('echo'),
        { role: 'assistant', content: 'done normally' },
      ]);

      const events = await collectEvents(client, [echo], {
        config: { maxTurns: 10 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
    });

    it('always allows at least one turn before checking time budget', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        makeToolCallMessage('echo'),
        { role: 'assistant', content: 'Synthesized after time.' },
      ]);

      // Mock Date.now so every call returns past-budget time.
      const base = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(base + 500_000);

      try {
        const events = await collectEvents(client, [echo], {
          config: { maxTurns: 10, maxTimeMs: 180_000 },
        });

        // Should have at least one tool call before time budget kicks in
        expect(events.filter((e) => e.type === 'tool_call').length).toBeGreaterThanOrEqual(1);
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  describe('repetition detection', () => {
    function makeToolCallMessage(name: string, args: Record<string, unknown> = {}): Message {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name, arguments: args } }],
      } as Message;
    }

    it('breaks to synthesis when model repeats the same text response', async () => {
      // The model uses a tool first (so autoContinue remains active),
      // then produces 3 identical text responses with a continuation
      // prompt. autoContinue fires on turns 1 and 2, but the repetition
      // detector catches the 3rd identical text (REPETITION_LIMIT=2).
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const repeatedText = 'Here are results. Shall I continue?';
      const client = makeClient([
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'echo', arguments: {} } }],
        } as Message,
        { role: 'assistant', content: repeatedText },
        { role: 'assistant', content: repeatedText },
        { role: 'assistant', content: repeatedText },
        { role: 'assistant', content: 'Synthesized after repetition.' },
      ]);

      const events = await collectEvents(client, [echo], {
        config: { maxTurns: 10, autoContinue: true, autoContinueLimit: 5 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'repetition_synthesized' }));
      const error = events.find((e) => e.type === 'error' && (e as { message: string }).message.includes('repeating'));
      expect(error).toBeDefined();
    });

    it('does not trigger when tool calls differ', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        makeToolCallMessage('echo', { value: 'a' }),
        makeToolCallMessage('echo', { value: 'b' }),
        { role: 'assistant', content: 'Done with different calls.' },
      ]);

      const events = await collectEvents(client, [echo], {
        config: { maxTurns: 10 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
    });

    it('resets repetition counter when output changes', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        makeToolCallMessage('echo', { value: 'a' }),
        makeToolCallMessage('echo', { value: 'b' }),
        makeToolCallMessage('echo', { value: 'a' }),
        { role: 'assistant', content: 'Done after interleaved calls.' },
      ]);

      const events = await collectEvents(client, [echo], {
        config: { maxTurns: 10 },
      });

      const done = events.find((e) => e.type === 'done');
      expect(done).toEqual(expect.objectContaining({ type: 'done', reason: 'completed' }));
    });
  });

  describe('autoContinue', () => {
    function makeToolCallMessage(name: string): Message {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name, arguments: {} } }],
      } as Message;
    }

    it('auto-continues when model produces a partial result with suggestions', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        makeToolCallMessage('echo'),
        { role: 'assistant', content: 'Here is what I found so far.\n\n1. Analyze sales data\n2. Check inventory levels\n\nWould you like me to continue with these?' },
        { role: 'assistant', content: 'All analysis complete. Revenue is £45,000.' },
      ]);

      const events = await collectEvents(client, [echo], {
        config: { maxTurns: 10, autoContinue: true },
      });

      const autoCont = events.find((e) => e.type === 'auto_continue');
      expect(autoCont).toBeDefined();
      expect(autoCont).toMatchObject({ type: 'auto_continue', continuationCount: 1 });
      const texts = events.filter((e) => e.type === 'text');
      expect(texts).toHaveLength(2);
      expect(texts[1]).toMatchObject({ content: 'All analysis complete. Revenue is £45,000.' });
      const done = events.find((e) => e.type === 'done');
      expect(done).toMatchObject({ reason: 'completed' });
    });

    it('does not auto-continue when disabled', async () => {
      const client = makeClient([
        { role: 'assistant', content: 'Here is partial work.\n\nWould you like me to continue?' },
      ]);

      const events = await collectEvents(client, [], {
        config: { maxTurns: 10, autoContinue: false },
      });

      expect(events.find((e) => e.type === 'auto_continue')).toBeUndefined();
      expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed' });
    });

    it('respects autoContinueLimit', async () => {
      const echo = makeTool('echo', true, async () => ({ success: true, output: 'ok' }));
      const client = makeClient([
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'echo', arguments: {} } }],
        } as Message,
        { role: 'assistant', content: 'Step 1 done. Would you like me to continue?' },
        { role: 'assistant', content: 'Step 2 done. Shall I continue?' },
        { role: 'assistant', content: 'Step 3 done. Should I continue?' },
      ]);

      const events = await collectEvents(client, [echo], {
        config: { maxTurns: 10, autoContinue: true, autoContinueLimit: 2 },
      });

      const autoCounts = events.filter((e) => e.type === 'auto_continue');
      expect(autoCounts).toHaveLength(2);
      // Third response stops the loop normally since limit reached
      const done = events.find((e) => e.type === 'done');
      expect(done).toMatchObject({ reason: 'completed' });
    });

    it('does not auto-continue on genuine final answers', async () => {
      const client = makeClient([
        { role: 'assistant', content: 'The total revenue for Q1 was £45,230. Costs were £32,100. Net profit: £13,130.' },
      ]);

      const events = await collectEvents(client, [], {
        config: { maxTurns: 10, autoContinue: true },
      });

      expect(events.find((e) => e.type === 'auto_continue')).toBeUndefined();
      expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed' });
    });

    it('stops auto-continuing after one chance when model never uses tools', async () => {
      const client = makeClient([
        { role: 'assistant', content: 'Here are some ideas. Would you like me to continue?' },
        { role: 'assistant', content: 'More ideas. Shall I continue?' },
        { role: 'assistant', content: 'Even more. Should I continue?' },
      ]);

      const events = await collectEvents(client, [], {
        config: { maxTurns: 10, autoContinue: true, autoContinueLimit: 5 },
      });

      const autoCounts = events.filter((e) => e.type === 'auto_continue');
      expect(autoCounts).toHaveLength(1);
      const done = events.find((e) => e.type === 'done');
      expect(done).toMatchObject({ reason: 'completed' });
    });

    it('does not auto-continue on high-risk task types', async () => {
      const client = makeClient([
        { role: 'assistant', content: 'I found the account. Would you like me to execute the trade now?' },
      ]);

      const events = await collectEvents(client, [], {
        config: { maxTurns: 10, autoContinue: true, taskType: 'financial_execution' },
      });

      expect(events.find((e) => e.type === 'auto_continue')).toBeUndefined();
      expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed' });
    });

    it('auto-continues on safe task types like financial_analysis', async () => {
      const client = makeClient([
        { role: 'assistant', content: 'Sales data loaded. Would you like me to analyze the profit margins too?' },
        { role: 'assistant', content: 'Full analysis complete. Revenue: £45k, costs: £32k, net: £13k.' },
      ]);

      const events = await collectEvents(client, [], {
        config: { maxTurns: 10, autoContinue: true, taskType: 'financial_analysis' },
      });

      expect(events.find((e) => e.type === 'auto_continue')).toBeDefined();
    });
  });

  describe('detectPartialResult', () => {
    it('detects "would you like me to" continuation prompts', () => {
      expect(detectPartialResult('Here are the results. Would you like me to analyze further?')).toContain('would you like me to');
    });

    it('detects "shall I continue" prompts', () => {
      expect(detectPartialResult('I have completed step 1. Shall I continue with step 2?')).toContain('shall i continue');
    });

    it('detects numbered suggestions at end', () => {
      const text = 'Here is what I found:\n\n1. Analyze the sales trends\n2. Check inventory levels\n3. Review profit margins';
      expect(detectPartialResult(text)).toContain('numbered suggestions');
    });

    it('returns null for genuine final answers', () => {
      expect(detectPartialResult('The total revenue was £45,000 with a net profit of £13,130.')).toBeNull();
    });

    it('returns null for short or empty text', () => {
      expect(detectPartialResult('')).toBeNull();
      expect(detectPartialResult('OK')).toBeNull();
    });
  });
});