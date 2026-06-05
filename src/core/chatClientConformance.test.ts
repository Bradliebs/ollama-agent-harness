import type { Message, Tool } from 'ollama';
import type { ChatResult, IChatClient, ModelLocality, StreamChunk } from './chatClient';
import { runChatClientConformance } from './chatClientConformance';

/**
 * A minimal, fully in-memory IChatClient used to validate the conformance suite
 * itself. Backends (OllamaClient, OpenAIClient, ...) can call
 * runChatClientConformance from their own test files with a client wired to a
 * fake transport; this reference implementation locks the contract the suite
 * enforces.
 */
class ReferenceChatClient implements IChatClient {
  constructor(private readonly model: string) {}

  private result(content = 'pong'): ChatResult {
    return {
      message: { role: 'assistant', content },
      usage: { promptTokens: 3, completionTokens: 2, totalDurationNs: 1_000 },
    };
  }

  async chat(_messages: Message[], _tools?: Tool[], _abortSignal?: AbortSignal): Promise<ChatResult> {
    return this.result();
  }

  async chatOnce(_messages: Message[], _tools?: Tool[]): Promise<ChatResult> {
    return this.result();
  }

  async *chatStream(_messages: Message[], _tools?: Tool[], _abortSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
    yield { content: 'po', done: false };
    yield { content: 'ng', done: true };
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  async getContextWindow(): Promise<number | null> {
    return 4_096;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  getModel(): string {
    return this.model;
  }

  getLocality(): ModelLocality {
    return 'local';
  }
}

runChatClientConformance('ReferenceChatClient', {
  makeClient: () => new ReferenceChatClient('reference-model'),
  expectedModel: 'reference-model',
});
