import { describe, it, expect } from '@jest/globals';
import type { Message, Tool } from 'ollama';
import type { IChatClient, ChatResult, StreamChunk } from '../../core/chatClient';
import { createLlmAdversaryJudge } from './llmJudge';

function stubClient(response: string): IChatClient {
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalDurationNs: 0,
  };
  const result: ChatResult = {
    message: { role: 'assistant', content: response },
    usage,
  };
  return {
    async chat(_messages: Message[], _tools?: Tool[], _abortSignal?: AbortSignal): Promise<ChatResult> {
      return result;
    },
    async chatOnce(_messages: Message[], _tools?: Tool[]): Promise<ChatResult> {
      return result;
    },
    async *chatStream(_messages: Message[], _tools?: Tool[], _abortSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
      yield { content: response, done: true };
    },
    async listModels() { return []; },
    async getContextWindow() { return null; },
    async healthCheck() { return { ok: true }; },
    getModel() { return 'stub'; },
  };
}

function throwingClient(): IChatClient {
  return {
    async chat() { throw new Error('chat failed'); },
    async chatOnce() { throw new Error('chat failed'); },
    async *chatStream() { throw new Error('chat failed'); },
    async listModels() { return []; },
    async getContextWindow() { return null; },
    async healthCheck() { return { ok: true }; },
    getModel() { return 'stub'; },
  };
}

const input = { command: 'rm -rf /', rules: 'BLOCK destructive commands.', toolName: 'bash' };

describe('createLlmAdversaryJudge', () => {
  it('parses a BLOCK response with reason', async () => {
    const judge = createLlmAdversaryJudge(stubClient('BLOCK wipes the whole filesystem'));
    const out = await judge(input);
    expect(out.block).toBe(true);
    expect(out.reason).toBe('wipes the whole filesystem');
  });

  it('parses an ALLOW response with reason', async () => {
    const judge = createLlmAdversaryJudge(stubClient('ALLOW normal dev command'));
    const out = await judge(input);
    expect(out.block).toBe(false);
    expect(out.reason).toBe('normal dev command');
  });

  it('treats unrecognised tokens as ALLOW (fail open)', async () => {
    const judge = createLlmAdversaryJudge(stubClient('Maybe? I am not sure'));
    const out = await judge(input);
    expect(out.block).toBe(false);
  });

  it('case-insensitive on the first token', async () => {
    const judge = createLlmAdversaryJudge(stubClient('block obviously dangerous'));
    const out = await judge(input);
    expect(out.block).toBe(true);
  });

  it('uses placeholder reason when only the verdict is returned', async () => {
    const judge = createLlmAdversaryJudge(stubClient('BLOCK'));
    const out = await judge(input);
    expect(out.block).toBe(true);
    expect(out.reason).toBe('no reason provided');
  });

  it('propagates chat errors so the inspector can fail open', async () => {
    const judge = createLlmAdversaryJudge(throwingClient());
    await expect(judge(input)).rejects.toThrow('chat failed');
  });
});
