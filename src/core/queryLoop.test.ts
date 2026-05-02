import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
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

    expect(events.map((event) => event.type)).toEqual(['text', 'done']);
    expect(events[0]).toEqual({ type: 'text', content: 'All done.' });
  });

  it('emits output validation before final text when validation is enabled', async () => {
    const client = makeClient([{ role: 'assistant', content: 'All done.' }]);

    const events = await collectEvents(client, [], {
      config: { outputValidation: { enabled: true, profile: 'oracle-prime' } },
    });

    expect(events.map((event) => event.type)).toEqual(['output_validation', 'text', 'done']);
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

    expect(events.map((event) => event.type)).toEqual(['tool_call', 'tool_result', 'text', 'done']);
    expect(events[1]).toMatchObject({ type: 'tool_result', result: { success: true, output: 'echo:x' } });
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
});