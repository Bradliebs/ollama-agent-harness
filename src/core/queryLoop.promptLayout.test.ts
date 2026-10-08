import type { Message } from 'ollama';
import { queryLoop, TURN_CONTEXT_TAG } from './queryLoop';
import { assembleSystemContext, assembleSystemContextSections, contextScale } from '../context/assembly';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { LoopConfig, LoopEvent } from '../types';
import { buildTaskContract } from './taskContractBuilder';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

async function firstRequest(config: Partial<LoopConfig>, initial: Message[]): Promise<{ sent: Message[]; events: LoopEvent[] }> {
  const sent: Message[][] = [];
  const chat = jest.fn(async (messages: Message[]) => {
    sent.push(JSON.parse(JSON.stringify(messages)) as Message[]);
    return { message: { role: 'assistant', content: 'answer' } as Message };
  });
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'm', systemPrompt: 'STATIC RULES', maxTurns: 2, context: { enabled: false }, supervisor: false, ...config },
    { client: { chat } as never, tools: [] },
    initial,
  )) events.push(event);
  return { sent: sent[0], events };
}

const contract = (goal: string) => buildTaskContract(goal);

describe('cache prompt layout', () => {
  const history: Message[] = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }];

  it('keeps the system prompt identical across messages and puts per-message context before the user message', async () => {
    const one = await firstRequest({ promptLayout: 'cache', turnContext: 'recall for message one', taskContract: contract('fix bug one'), outputValidation: { enabled: true, profile: 'tool-result-summary' } }, [...history, { role: 'user', content: 'message one' }]);
    const two = await firstRequest({ promptLayout: 'cache', turnContext: 'recall for message two', taskContract: contract('fix bug two') }, [...history, { role: 'user', content: 'message two' }]);

    expect(one.sent[0]).toEqual(two.sent[0]);
    expect(String(one.sent[0].content)).toBe('STATIC RULES');
    // system, history (cacheable prefix), then the context block, then the message.
    expect(one.sent.slice(1, 3)).toEqual(history);
    const context = String(one.sent[3].content);
    expect(one.sent[3].role).toBe('user');
    expect(context.startsWith(`<${TURN_CONTEXT_TAG}>`)).toBe(true);
    expect(context).toContain('recall for message one');
    expect(context).toContain('fix bug one');
    expect(context).toContain('Output Validation Contract');
    expect(one.sent[4]).toEqual({ role: 'user', content: 'message one' });
  });

  it('keeps the turn context through compaction and in the synthesis call', async () => {
    const sent: Message[][] = [];
    const probe = { name: 'probe', description: 'probe', parameters: { type: 'object', properties: { q: { type: 'string' } } }, isReadOnly: true, execute: async () => ({ success: true, output: 'r'.repeat(1500) }) };
    let calls = 0;
    const chat = jest.fn(async (messages: Message[], tools: unknown[] = []) => {
      sent.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      if (String(messages[0]?.content).startsWith('You are a conversation summarizer')) return { message: { role: 'assistant', content: 'summary of probes' } as Message };
      calls += 1;
      return (tools as unknown[]).length > 0
        ? { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'probe', arguments: { q: `attempt ${calls}` } } }] } as Message }
        : { message: { role: 'assistant', content: 'final summary' } as Message };
    });
    for await (const _event of queryLoop(
      { model: 'm', systemPrompt: 'STATIC RULES', maxTurns: 6, context: { maxTokens: 2500, minSummaryQuality: 0 }, supervisor: false, promptLayout: 'cache', taskContract: contract('fix the parser bug') },
      { client: { chat } as never, tools: [probe] },
      [{ role: 'user', content: 'do the thing' }],
    )) { /* consume */ }
    const workerRequests = sent.filter((request) => !String(request[0]?.content).startsWith('You are a conversation summarizer'));
    // Compaction ran (some request is shorter than the one before it)...
    expect(workerRequests.some((request, i) => i > 0 && request.length < workerRequests[i - 1].length)).toBe(true);
    // ...yet every request, including the final tool-less synthesis, still carries the contract.
    for (const request of workerRequests) {
      expect(request.some((m) => m.role === 'user' && String(m.content).includes('fix the parser bug'))).toBe(true);
    }
  });

  it('leaves the default layout unchanged', async () => {
    const plain = await firstRequest({ taskContract: contract('fix bug one') }, [{ role: 'user', content: 'message one' }]);
    expect(plain.sent).toHaveLength(2);
    expect(String(plain.sent[0].content)).toContain('fix bug one');
    expect(String(plain.sent[0].content)).toContain('STATIC RULES');
  });

  it('splits assembled context into static and per-message sections without changing the joined text', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-layout-'));
    try {
      await fs.writeFile(path.join(dir, 'HARNESS.md'), 'project memory', 'utf-8');
      const input = { systemPrompt: 'base', projectDir: dir, skillsDir: path.join(dir, 'none') };
      const sections = await assembleSystemContextSections(input);
      expect(sections.static).toContain('project memory');
      expect(sections.perMessage).toBe('');
      expect(await assembleSystemContext(input)).toBe(sections.static);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('shrinks memory sections for small context windows only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-scale-'));
    try {
      await fs.writeFile(path.join(dir, 'HARNESS.md'), 'm'.repeat(20_000), 'utf-8');
      const input = { systemPrompt: 'base', projectDir: dir, skillsDir: path.join(dir, 'none') };
      const full = (await assembleSystemContext(input)).length;
      expect((await assembleSystemContext({ ...input, contextWindowTokens: 128_000 })).length).toBe(full);
      const small = (await assembleSystemContext({ ...input, contextWindowTokens: 8_192 })).length;
      expect(small).toBeLessThan(full - 5_000);
      expect(contextScale(8_192)).toBe(0.25);
      expect(contextScale(undefined)).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
