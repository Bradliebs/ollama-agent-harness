import type { Message, Tool } from 'ollama';
import type { ModelLocality } from '../observability/costProvenance';

export type { ModelLocality } from '../observability/costProvenance';

/**
 * Per-LLM-call usage stats. Same shape used by OllamaClient and any other
 * backend so the agent loop and UI surface a consistent token/duration view.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalDurationNs: number;
  /** Nanoseconds spent loading the model into memory (0 when already cached). */
  loadDurationNs?: number;
  /** Nanoseconds spent evaluating the prompt (prefill). */
  promptEvalDurationNs?: number;
  /** Nanoseconds spent generating tokens. */
  evalDurationNs?: number;
}

export interface ChatResult {
  message: Message;
  usage: TokenUsage;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  toolCalls?: Message['tool_calls'];
}

/**
 * Minimal interface the agent loop, compaction, and subagents need from a
 * chat backend. Allows the harness to plug in non-Ollama providers
 * (Cerebras, Groq, GitHub Models, Mistral, etc.) without refactoring the
 * core loop. Keep this surface as small as possible — every method below
 * is currently used somewhere in the codebase.
 */
export interface IChatClient {
  chat(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): Promise<ChatResult>;
  chatOnce(messages: Message[], tools?: Tool[]): Promise<ChatResult>;
  chatStream(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): AsyncGenerator<StreamChunk>;
  listModels(): Promise<string[]>;
  getContextWindow(): Promise<number | null>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
  getModel(): string;
  /**
   * Authoritative locality of the backend serving this client: 'local' for
   * an on-box runtime (Ollama), 'cloud' for a hosted provider. Optional so
   * existing clients/stubs stay valid; consumers fall back to registry
   * classification when absent. The serving client knows the truth even for
   * off-registry models (custom local pulls), which the registry cannot.
   */
  getLocality?(): ModelLocality;
}
