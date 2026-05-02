import type { Message, Tool } from 'ollama';

/**
 * Per-LLM-call usage stats. Same shape used by OllamaClient and any other
 * backend so the agent loop and UI surface a consistent token/duration view.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalDurationNs: number;
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
  chatStream(messages: Message[], tools?: Tool[]): AsyncGenerator<StreamChunk>;
  listModels(): Promise<string[]>;
  getContextWindow(): Promise<number | null>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
  getModel(): string;
}
