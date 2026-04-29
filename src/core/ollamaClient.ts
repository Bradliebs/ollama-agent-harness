import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse, Message, Tool } from 'ollama';

export interface OllamaClientConfig {
  host?: string;
  model: string;
  keepAlive?: string;
  numCtx?: number;
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
  private numCtx?: number;

  constructor(config: OllamaClientConfig) {
    this.client = new Ollama({ host: config.host ?? 'http://localhost:11434' });
    this.model = config.model;
    this.keepAlive = config.keepAlive ?? '5m';
    this.numCtx = config.numCtx;
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
      options: this.numCtx ? { num_ctx: this.numCtx } : undefined,
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
      options: this.numCtx ? { num_ctx: this.numCtx } : undefined,
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

  async getContextWindow(): Promise<number | null> {
    try {
      const response = await this.client.show({ model: this.model });
      return extractContextWindow(response.model_info) ?? extractNumCtxParameter(response.parameters);
    } catch {
      return null;
    }
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

function extractContextWindow(modelInfo: unknown): number | null {
  const entries = modelInfo instanceof Map
    ? Array.from(modelInfo.entries())
    : typeof modelInfo === 'object' && modelInfo !== null
      ? Object.entries(modelInfo as Record<string, unknown>)
      : [];
  for (const [key, value] of entries) {
    if (!key.endsWith('.context_length') && key !== 'context_length') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

function extractNumCtxParameter(parameters: unknown): number | null {
  const match = String(parameters ?? '').match(/(?:num_ctx|context_length)\s+(\d+)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
