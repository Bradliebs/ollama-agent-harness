import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Message } from 'ollama';
import { BudgetEnforcingChatClient, BudgetExceededError } from './budgetEnforcingClient';
import { recordSpend } from './dailyBudget';
import type { ChatResult, IChatClient, StreamChunk, TokenUsage } from '../core/chatClient';

class FakeClient implements IChatClient {
  public chatCalls = 0;
  public streamCalls = 0;
  constructor(private readonly model: string, private readonly usage: TokenUsage = { promptTokens: 1000, completionTokens: 500, totalDurationNs: 0 }) {}
  async chat(_m: Message[], _t?: unknown, _a?: AbortSignal): Promise<ChatResult> {
    this.chatCalls += 1;
    return { message: { role: 'assistant', content: 'ok' }, usage: this.usage };
  }
  chatOnce(m: Message[]): Promise<ChatResult> { return this.chat(m); }
  async *chatStream(_m: Message[]): AsyncGenerator<StreamChunk> {
    this.streamCalls += 1;
    yield { content: 'hello world', done: false };
    yield { content: '', done: true };
  }
  listModels(): Promise<string[]> { return Promise.resolve([this.model]); }
  getContextWindow(): Promise<number | null> { return Promise.resolve(null); }
  healthCheck(): Promise<{ ok: boolean }> { return Promise.resolve({ ok: true }); }
  getModel(): string { return this.model; }
  getLocality(): 'cloud' { return 'cloud'; }
}

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-client-test-'));
  await fs.mkdir(path.join(dir, '.harness'), { recursive: true });
  return dir;
}

async function rm(dir: string): Promise<void> { await fs.rm(dir, { recursive: true, force: true }); }

describe('BudgetEnforcingChatClient', () => {
  it('passes through when cap is 0 (off)', async () => {
    const dir = await tempProject();
    try {
      const inner = new FakeClient('gpt-4o');
      const client = new BudgetEnforcingChatClient({ inner, projectDir: dir, getCapUsd: () => 0 });
      const result = await client.chat([{ role: 'user', content: 'hi' }]);
      expect(result.message.content).toBe('ok');
      expect(inner.chatCalls).toBe(1);
    } finally { await rm(dir); }
  });

  it('records spend after a successful chat using model rates', async () => {
    const dir = await tempProject();
    try {
      const inner = new FakeClient('gpt-4o', { promptTokens: 1000, completionTokens: 1000, totalDurationNs: 0 });
      // gpt-4o rates: input 0.0025/1k, output 0.01/1k -> 0.0025 + 0.01 = 0.0125
      const records: Array<{ estimatedCostUsd: number; crossedBlock: boolean }> = [];
      const client = new BudgetEnforcingChatClient({
        inner,
        projectDir: dir,
        getCapUsd: () => 5,
        onSpendRecorded: (info) => records.push({ estimatedCostUsd: info.estimatedCostUsd, crossedBlock: info.crossedBlock }),
      });
      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(records.length).toBe(1);
      expect(records[0].estimatedCostUsd).toBeCloseTo(0.0125, 6);
      expect(records[0].crossedBlock).toBe(false);
    } finally { await rm(dir); }
  });

  it('throws BudgetExceededError when cap already reached on next call', async () => {
    const dir = await tempProject();
    try {
      await recordSpend(dir, { modelId: 'gpt-4o', estimatedCostUsd: 5 }, 5);
      const inner = new FakeClient('gpt-4o');
      const client = new BudgetEnforcingChatClient({ inner, projectDir: dir, getCapUsd: () => 5 });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(BudgetExceededError);
      expect(inner.chatCalls).toBe(0);
    } finally { await rm(dir); }
  });

  it('throws BudgetExceededError when spend file is corrupt (fail-closed)', async () => {
    const dir = await tempProject();
    try {
      await fs.writeFile(path.join(dir, '.harness', 'daily-spend.json'), 'not json', 'utf-8');
      const inner = new FakeClient('gpt-4o');
      const client = new BudgetEnforcingChatClient({ inner, projectDir: dir, getCapUsd: () => 5 });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(BudgetExceededError);
      expect(inner.chatCalls).toBe(0);
    } finally { await rm(dir); }
  });

  it('meters streaming output via heuristic', async () => {
    const dir = await tempProject();
    try {
      const inner = new FakeClient('gpt-4o');
      const records: Array<{ estimatedCostUsd: number }> = [];
      const client = new BudgetEnforcingChatClient({
        inner,
        projectDir: dir,
        getCapUsd: () => 5,
        onSpendRecorded: (info) => records.push({ estimatedCostUsd: info.estimatedCostUsd }),
      });
      const chunks: string[] = [];
      for await (const c of client.chatStream([{ role: 'user', content: 'short prompt' }])) {
        chunks.push(c.content);
      }
      expect(chunks.join('')).toBe('hello world');
      expect(records.length).toBe(1);
      expect(records[0].estimatedCostUsd).toBeGreaterThan(0);
      expect(inner.streamCalls).toBe(1);
    } finally { await rm(dir); }
  });

  it('records partial cost even when stream is aborted', async () => {
    const dir = await tempProject();
    try {
      class AbortingClient extends FakeClient {
        async *chatStream(): AsyncGenerator<StreamChunk> {
          yield { content: 'partial', done: false };
          throw new Error('stream aborted');
        }
      }
      const inner = new AbortingClient('gpt-4o');
      const records: Array<{ estimatedCostUsd: number }> = [];
      const client = new BudgetEnforcingChatClient({
        inner,
        projectDir: dir,
        getCapUsd: () => 5,
        onSpendRecorded: (info) => records.push({ estimatedCostUsd: info.estimatedCostUsd }),
      });
      const consume = async (): Promise<void> => {
        for await (const _c of client.chatStream([{ role: 'user', content: 'x' }])) { /* ignore */ }
      };
      await expect(consume()).rejects.toThrow('stream aborted');
      expect(records.length).toBe(1);
      expect(records[0].estimatedCostUsd).toBeGreaterThan(0);
    } finally { await rm(dir); }
  });

  it('uses inner getModel/getLocality/listModels passthrough', async () => {
    const dir = await tempProject();
    try {
      const inner = new FakeClient('gpt-4o');
      const client = new BudgetEnforcingChatClient({ inner, projectDir: dir, getCapUsd: () => 0 });
      expect(client.getModel()).toBe('gpt-4o');
      expect(client.getLocality()).toBe('cloud');
      await expect(client.listModels()).resolves.toEqual(['gpt-4o']);
    } finally { await rm(dir); }
  });
});
