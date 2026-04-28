/**
 * Ollama Agent Harness — API Client Recipe
 *
 * Thin wrapper around the official ollama-js library that provides:
 * - Streaming chat with tool calling support
 * - Message history management
 * - Token usage tracking
 * - Connection health checks
 */

import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse, Message, Tool } from 'ollama';

// --- Client Configuration ---

export interface HarnessClientConfig {
  host?: string;         // Default: http://localhost:11434
  model: string;         // e.g. 'qwen2.5-coder:7b', 'llama3.1:8b'
  keepAlive?: string;    // Model keep-alive duration, e.g. '5m'
  systemPrompt?: string;
}

// --- Token Usage Tracking ---

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalDuration: number;  // nanoseconds
}

// --- Client ---

export class OllamaHarnessClient {
  private client: Ollama;
  private model: string;
  private keepAlive: string;
  private systemPrompt: string | undefined;

  constructor(config: HarnessClientConfig) {
    this.client = new Ollama({ host: config.host ?? 'http://localhost:11434' });
    this.model = config.model;
    this.keepAlive = config.keepAlive ?? '5m';
    this.systemPrompt = config.systemPrompt;
  }

  /**
   * Non-streaming chat call. Returns the full response.
   */
  async chat(
    messages: Message[],
    tools?: Tool[],
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const allMessages = this.prependSystemPrompt(messages);

    const response: ChatResponse = await this.client.chat({
      model: this.model,
      messages: allMessages,
      tools,
      stream: false,
      keep_alive: this.keepAlive,
    } as ChatRequest);

    return {
      message: response.message,
      usage: {
        promptTokens: response.prompt_eval_count ?? 0,
        completionTokens: response.eval_count ?? 0,
        totalDuration: response.total_duration ?? 0,
      },
    };
  }

  /**
   * Streaming chat call. Yields chunks as they arrive.
   */
  async *chatStream(
    messages: Message[],
    tools?: Tool[],
  ): AsyncGenerator<{ content: string; done: boolean; toolCalls?: Message['tool_calls'] }> {
    const allMessages = this.prependSystemPrompt(messages);

    const stream = await this.client.chat({
      model: this.model,
      messages: allMessages,
      tools,
      stream: true,
      keep_alive: this.keepAlive,
    } as ChatRequest);

    for await (const chunk of stream) {
      yield {
        content: chunk.message?.content ?? '',
        done: chunk.done ?? false,
        toolCalls: chunk.message?.tool_calls,
      };
    }
  }

  /**
   * Check if Ollama is reachable and the model is available.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const models = await this.client.list();
      const available = models.models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`)
      );
      if (!available) {
        return { ok: false, error: `Model '${this.model}' not found. Available: ${models.models.map(m => m.name).join(', ')}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `Cannot connect to Ollama: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private prependSystemPrompt(messages: Message[]): Message[] {
    if (!this.systemPrompt) return messages;
    if (messages.length > 0 && messages[0].role === 'system') return messages;
    return [{ role: 'system', content: this.systemPrompt }, ...messages];
  }
}

// --- Usage Example ---

async function example() {
  const client = new OllamaHarnessClient({
    model: 'qwen2.5-coder:7b',
    systemPrompt: 'You are a helpful coding assistant.',
  });

  // Health check
  const health = await client.healthCheck();
  if (!health.ok) {
    console.error(health.error);
    return;
  }

  // Simple chat
  const { message, usage } = await client.chat([
    { role: 'user', content: 'What is the factorial function in TypeScript?' },
  ]);
  console.log(message.content);
  console.log(`Tokens: ${usage.promptTokens} prompt, ${usage.completionTokens} completion`);

  // Chat with tools
  const tools: Tool[] = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  }];

  const { message: toolMsg } = await client.chat(
    [{ role: 'user', content: 'Read the file package.json' }],
    tools,
  );

  if (toolMsg.tool_calls?.length) {
    console.log('Tool calls:', toolMsg.tool_calls);
  }
}

example().catch(console.error);
