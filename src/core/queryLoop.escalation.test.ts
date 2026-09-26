import type { Message } from 'ollama';
import { queryLoop, type QueryLoopDeps } from './queryLoop';
import { RunSupervisor } from './supervisor';
import { selectEscalationTarget } from '../agents/modelRouting';
import type { LoopConfig, LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const page = 'Fujifilm X100VI: best price £1,669.28, used from £1,636.';

function tools(): Tool[] {
  return [
    {
      name: 'web_search',
      description: 'search',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      isReadOnly: true,
      execute: jest.fn(async () => ({ success: true, output: 'No results found.' })),
    },
    {
      name: 'web_read',
      description: 'read',
      parameters: { type: 'object', properties: { url: { type: 'string' } } },
      isReadOnly: true,
      execute: jest.fn(async () => ({ success: true, output: page })),
    },
  ];
}

function scripted(replies: Message[]) {
  const seen: Message[][] = [];
  return {
    seen,
    chat: jest.fn(async (messages: Message[]) => {
      seen.push(messages.map((message) => ({ ...message })));
      return { message: replies.shift() ?? ({ role: 'assistant', content: 'fallback' } as Message) };
    }),
  };
}

const search = (query: string) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query } } }] }) as Message;

async function run(weak: ReturnType<typeof scripted>, deps: Partial<QueryLoopDeps>, config: Partial<LoopConfig> = {}) {
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'qwen3.5:4b', systemPrompt: 'You are Moss.', maxTurns: 12, context: { enabled: false }, verifyResearch: 'off', supervisor: { stallTurns: 1 }, ...config },
    { client: weak as never, tools: tools(), permissionCheck: async () => ({ allowed: true }), ...deps },
    [{ role: 'user', content: 'What does the X100VI cost in the UK?' }],
  )) events.push(event);
  const texts = events.filter((event): event is Extract<LoopEvent, { type: 'text' }> => event.type === 'text');
  return { events, finalText: String(texts[texts.length - 1]?.content ?? ''), done: events.find((event) => event.type === 'done') };
}

describe('in-run escalation', () => {
  it('hands a stuck run to a stronger model once, and the stronger model finishes it', async () => {
    const weak = scripted(Array.from({ length: 10 }, (_, i) => search(`x100vi price attempt ${i}`)));
    const strong = scripted([{ role: 'assistant', content: 'It is about £1,669 new.' } as Message]);
    const escalate = jest.fn(async () => ({ model: 'openrouter/anthropic/claude-sonnet-4.5', client: strong as never }));
    const { events, finalText, done } = await run(weak, { escalate });

    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ fromModel: 'qwen3.5:4b', reason: 'stuck' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'model_escalated', from: 'qwen3.5:4b', to: 'openrouter/anthropic/claude-sonnet-4.5', reason: 'stuck' }));
    const stages = events.filter((event) => event.type === 'supervisor').map((event) => (event as { stage: string }).stage);
    expect(stages).toEqual(['warn', 'change_strategy', 'escalate']);
    expect(String(strong.seen[0][strong.seen[0].length - 1].content)).toMatch(/stronger model .* is taking over/);
    expect(weak.chat.mock.calls.length).toBeLessThan(10);
    expect(finalText).toBe('It is about £1,669 new.');
    expect(done).toMatchObject({ reason: 'completed' });
  });

  it('asks the human when there is nothing stronger to escalate to', async () => {
    const weak = scripted(Array.from({ length: 12 }, (_, i) => search(`attempt ${i}`)));
    const escalate = jest.fn(async () => null);
    const { events, done } = await run(weak, { escalate });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'model_escalated')).toBe(false);
    expect(done).toMatchObject({ reason: 'stuck_needs_human' });
  });

  it('escalates after the verifier rejects the answer twice in gate mode', async () => {
    const read = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_read', arguments: { url: 'https://prices.example/x100vi' } } }] } as Message;
    const wrong = { role: 'assistant', content: 'The X100VI is £1,999 new.' } as Message;
    const weak = scripted([read, wrong, { ...wrong }]);
    const strong = scripted([{ role: 'assistant', content: 'The X100VI is £1,669.28 new and £1,636 used.' } as Message]);
    const escalate = jest.fn(async () => ({ model: 'kimi-k3:cloud', client: strong as never }));
    const { events, finalText } = await run(weak, { escalate }, { verifyResearch: 'gate', supervisor: false });

    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'verifier_rejected' }));
    const sequence = events
      .filter((event) => event.type === 'verification' || event.type === 'model_escalated')
      .map((event) => (event.type === 'verification' ? event.overall : 'escalated'));
    expect(sequence).toEqual(['warn', 'warn', 'escalated', 'pass']);
    expect(weak.chat).toHaveBeenCalledTimes(3);
    expect(finalText.startsWith('The X100VI is £1,669.28 new')).toBe(true);
  });
});

describe('escalation helpers', () => {
  it('targets the strong tier only when it is a different model', () => {
    expect(selectEscalationTarget('qwen3.5:4b', { strong: 'openrouter/anthropic/claude-sonnet-4.5', default: 'glm-5.3:cloud' })).toBe('openrouter/anthropic/claude-sonnet-4.5');
    expect(selectEscalationTarget('glm-5.3:cloud', { strong: 'GLM-5.3:cloud' })).toBeUndefined();
    expect(selectEscalationTarget('glm-5.3:cloud', {})).toBeUndefined();
  });

  it('resetStall gives the new model a fresh stall count but remembers seen results', () => {
    const supervisor = new RunSupervisor({ stallTurns: 1 });
    const turn = { toolCalls: 1, newSources: 0, filesChanged: 0, successfulResults: [{ name: 'web_search', output: 'same' }], attempts: ['web_search(x)'] };
    supervisor.endTurn(turn);
    expect(supervisor.endTurn(turn)).toMatchObject({ kind: 'intervene', stage: 'warn' });
    supervisor.resetStall();
    expect(supervisor.stalledTurns).toBe(0);
    expect(supervisor.endTurn(turn)).toMatchObject({ kind: 'intervene', stage: 'warn' });
  });
});
