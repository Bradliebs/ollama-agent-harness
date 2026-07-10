import { makeQueryLoopRunner } from './queryLoopRunner';
import { makeGoal } from './types';
import type { Goal } from './types';
import type { IChatClient, ChatResult, StreamChunk } from '../core/chatClient';
import type { Message } from 'ollama';

// Minimal stub IChatClient that returns a fixed reply. queryLoop sees no
// tool calls so it ends after one turn with reason 'completed'.
function makeStubClient(reply: string, promptTokens = 5, completionTokens = 7): IChatClient {
  return {
    chat: async (_msgs: Message[]): Promise<ChatResult> => ({
      message: { role: 'assistant', content: reply },
      usage: { promptTokens, completionTokens, totalDurationNs: 1_000_000 },
    }),
    chatOnce: async (_msgs: Message[]): Promise<ChatResult> => ({
      message: { role: 'assistant', content: reply },
      usage: { promptTokens, completionTokens, totalDurationNs: 1_000_000 },
    }),
    chatStream: async function* (_msgs: Message[]): AsyncGenerator<StreamChunk> {
      yield { content: reply, done: true };
    },
    listModels: async () => ['stub'],
    getContextWindow: async () => 8_000,
    healthCheck: async () => ({ ok: true }),
    getModel: () => 'stub',
  };
}

function makeFailingClient(message: string): IChatClient {
  return {
    chat: async () => { throw new Error(message); },
    chatOnce: async () => { throw new Error(message); },
    chatStream: async function* () { throw new Error(message); },
    listModels: async () => [],
    getContextWindow: async () => null,
    healthCheck: async () => ({ ok: false, error: message }),
    getModel: () => 'stub',
  };
}

function makeTestGoal(): Goal {
  return makeGoal({ target: 'do the thing' }, 'g-test');
}

describe('goal/queryLoopRunner', () => {
  it('runs a single iteration and reports done + tokens', async () => {
    const run = makeQueryLoopRunner({
      client: makeStubClient('all done', 10, 20),
      tools: [],
      model: 'stub',
      systemPrompt: 'You are a tester.',
    });
    const out = await run(makeTestGoal(), 1);
    expect(out.action).toMatch(/queryLoop done/);
    expect(out.tokensUsed).toBeGreaterThan(0);
    expect(out.notes).toContain('all done');
    expect(out.toolCalls).toBe(0);
    expect(out.error).toBeUndefined();
  });

  it('captures thrown errors into the outcome (does not crash the goal loop)', async () => {
    const run = makeQueryLoopRunner({
      client: makeFailingClient('backend explosion'),
      tools: [],
      model: 'stub',
      systemPrompt: 'You are a tester.',
    });
    const out = await run(makeTestGoal(), 2);
    // queryLoop catches client errors and emits an `error` event, then a
    // `done` event with reason='error'. The runner records the error
    // through the error event path and still returns a normal outcome.
    expect(out.error).toBeDefined();
  });

  it('caps captured notes at maxNotesChars', async () => {
    const big = 'x'.repeat(10_000);
    const run = makeQueryLoopRunner({
      client: makeStubClient(big),
      tools: [],
      model: 'stub',
      systemPrompt: 'You are a tester.',
      maxNotesChars: 200,
    });
    const out = await run(makeTestGoal(), 3);
    expect(out.notes!.length).toBeLessThan(400);
    expect(out.notes).toMatch(/truncated/);
  });

  it('forwards iteration number into the prompt (via task_id and final action)', async () => {
    const run = makeQueryLoopRunner({
      client: makeStubClient('ok'),
      tools: [],
      model: 'stub',
      systemPrompt: 'You are a tester.',
    });
    const out = await run(makeTestGoal(), 7);
    expect(out.action).toMatch(/iter 7/);
  });

  it('respects per-iteration maxTurns override', async () => {
    // Smoke test: just verify the runner does not error when an explicit
    // maxTurns override is passed. Actual turn-count enforcement lives in
    // queryLoop and is covered by its own tests.
    const run = makeQueryLoopRunner({
      client: makeStubClient('ok'),
      tools: [],
      model: 'stub',
      systemPrompt: 'You are a tester.',
      maxTurnsPerIteration: 3,
    });
    const out = await run(makeTestGoal(), 1);
    expect(out.action).toMatch(/queryLoop done/);
  });
});
