import type { Message } from 'ollama';
import type { ChatResult, IChatClient } from '../core/chatClient';
import { makeChatClientJudge, parseJudgeReply } from './judge';

// ── Minimal fake IChatClient ──────────────────────────────────────────────
class FakeClient implements IChatClient {
  public lastMessages: Message[] | null = null;
  constructor(private impl: (msgs: Message[]) => Promise<string> | string) {}
  async chatOnce(messages: Message[]): Promise<ChatResult> {
    this.lastMessages = messages;
    const content = await this.impl(messages);
    return {
      message: { role: 'assistant', content },
      usage: { promptTokens: 0, completionTokens: 0, totalDurationNs: 0 },
    };
  }
  async chat(messages: Message[]): Promise<ChatResult> { return this.chatOnce(messages); }
  async *chatStream(): AsyncGenerator<{ content: string; done: boolean }> { yield { content: '', done: true }; }
  async listModels(): Promise<string[]> { return []; }
  async getContextWindow(): Promise<number | null> { return null; }
  async healthCheck(): Promise<{ ok: boolean }> { return { ok: true }; }
  getModel(): string { return 'fake'; }
}

describe('parseJudgeReply', () => {
  it('parses a plain JSON reply', () => {
    expect(parseJudgeReply('{"score": 0.8, "rationale": "good"}')).toEqual({ score: 0.8, rationale: 'good' });
  });

  it('strips ```json fences', () => {
    const r = parseJudgeReply('```json\n{"score": 0.5, "rationale": "ok"}\n```');
    expect(r).toEqual({ score: 0.5, rationale: 'ok' });
  });

  it('strips ``` fences without a language tag', () => {
    const r = parseJudgeReply('```\n{"score": 1, "rationale": "yes"}\n```');
    expect(r).toEqual({ score: 1, rationale: 'yes' });
  });

  it('ignores prose surrounding the JSON object', () => {
    const r = parseJudgeReply('Sure! Here is my answer: {"score": 0.2, "rationale": "thin"} thanks.');
    expect(r).toEqual({ score: 0.2, rationale: 'thin' });
  });

  it('clamps out-of-range scores to [0, 1]', () => {
    expect(parseJudgeReply('{"score": 1.7, "rationale": ""}')?.score).toBe(1);
    expect(parseJudgeReply('{"score": -0.4, "rationale": ""}')?.score).toBe(0);
  });

  it('returns null on missing score', () => {
    expect(parseJudgeReply('{"rationale": "missing score"}')).toBeNull();
  });

  it('returns null on non-numeric score', () => {
    expect(parseJudgeReply('{"score": "high", "rationale": ""}')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseJudgeReply('not json at all')).toBeNull();
    expect(parseJudgeReply('')).toBeNull();
  });

  it('defaults rationale to "" when the field is missing', () => {
    expect(parseJudgeReply('{"score": 0.9}')).toEqual({ score: 0.9, rationale: '' });
  });
});

describe('makeChatClientJudge', () => {
  it('returns parsed score and rationale on a clean reply', async () => {
    const client = new FakeClient(() => '{"score": 0.9, "rationale": "looks great"}');
    const judge = makeChatClientJudge(client);
    const res = await judge({ rubric: 'is it good?', goalTarget: 'ship X' });
    expect(res).toEqual({ score: 0.9, rationale: 'looks great' });
  });

  it('passes goal target and rubric into the user message', async () => {
    const client = new FakeClient(() => '{"score": 0.5, "rationale": "ok"}');
    const judge = makeChatClientJudge(client);
    await judge({ rubric: 'the rubric body', goalTarget: 'the goal target' });
    expect(client.lastMessages).not.toBeNull();
    const userMsg = client.lastMessages![1];
    expect(userMsg.role).toBe('user');
    const content = typeof userMsg.content === 'string' ? userMsg.content : '';
    expect(content).toContain('the goal target');
    expect(content).toContain('the rubric body');
  });

  it('returns score 0 with a fallback rationale on unparseable output', async () => {
    const client = new FakeClient(() => 'no JSON here, sorry');
    const judge = makeChatClientJudge(client);
    const res = await judge({ rubric: 'r', goalTarget: 't' });
    expect(res.score).toBe(0);
    expect(res.rationale).toMatch(/unparseable output/);
  });

  it('returns score 0 with an error rationale when the client throws', async () => {
    const client = new FakeClient(() => { throw new Error('connection refused'); });
    const judge = makeChatClientJudge(client);
    const res = await judge({ rubric: 'r', goalTarget: 't' });
    expect(res.score).toBe(0);
    expect(res.rationale).toMatch(/judge call failed.*connection refused/);
  });

  it('truncates long rationales to maxRationaleChars', async () => {
    const long = 'A'.repeat(2000);
    const client = new FakeClient(() => `{"score": 0.7, "rationale": "${long}"}`);
    const judge = makeChatClientJudge(client, { maxRationaleChars: 50 });
    const res = await judge({ rubric: 'r', goalTarget: 't' });
    expect(res.rationale.length).toBe(50);
  });

  it('uses a custom systemPrompt when provided', async () => {
    const client = new FakeClient(() => '{"score": 1, "rationale": "y"}');
    const judge = makeChatClientJudge(client, { systemPrompt: 'CUSTOM JUDGE INSTRUCTIONS' });
    await judge({ rubric: 'r', goalTarget: 't' });
    expect(client.lastMessages![0].content).toBe('CUSTOM JUDGE INSTRUCTIONS');
  });
});
