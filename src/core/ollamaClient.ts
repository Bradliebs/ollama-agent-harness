import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse, Message, Tool } from 'ollama';

export interface OllamaClientConfig {
  host?: string;
  model: string;
  keepAlive?: string;
}

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

export class OllamaClient {
  private client: Ollama;
  private model: string;
  private keepAlive: string;

  constructor(config: OllamaClientConfig) {
    this.client = new Ollama({ host: config.host ?? 'http://localhost:11434' });
    this.model = config.model;
    this.keepAlive = config.keepAlive ?? '5m';
  }

  async chat(
    messages: Message[],
    tools?: Tool[],
  ): Promise<ChatResult> {
    const response = await this.client.chat({
      model: this.model,
      messages,
      tools,
      stream: false as const,
      keep_alive: this.keepAlive,
    });

    return {
      message: response.message,
      usage: {
        promptTokens: response.prompt_eval_count ?? 0,
        completionTokens: response.eval_count ?? 0,
        totalDurationNs: response.total_duration ?? 0,
      },
    };
  }

  async *chatStream(
    messages: Message[],
    tools?: Tool[],
  ): AsyncGenerator<StreamChunk> {
    const stream = await this.client.chat({
      model: this.model,
      messages,
      tools,
      stream: true as const,
      keep_alive: this.keepAlive,
    });

    for await (const chunk of stream) {
      yield {
        content: chunk.message?.content ?? '',
        done: chunk.done ?? false,
        toolCalls: chunk.message?.tool_calls,
      };
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.client.list();
    return response.models.map((m) => m.name);
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const models = await this.client.list();
      const available = models.models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );
      if (!available) {
        return {
          ok: false,
          error: `Model '${this.model}' not found. Available: ${models.models.map((m) => m.name).join(', ')}`,
        };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Cannot connect to Ollama: ${message}` };
    }
  }

  getModel(): string {
    return this.model;
  }
}
