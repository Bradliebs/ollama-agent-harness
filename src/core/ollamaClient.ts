import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse, Message, Tool, ToolCall } from 'ollama';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

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
    this.client = new Ollama({ host: config.host ?? 'http://localhost:11434', fetch: longLivedFetch });
    this.model = config.model;
    this.keepAlive = config.keepAlive ?? '5m';
    this.numCtx = config.numCtx;
  }

  async chat(
    messages: Message[],
    tools?: Tool[],
    abortSignal?: AbortSignal,
  ): Promise<ChatResult> {
    const response = await this.client.chat({
      model: this.model,
      messages,
      tools,
      stream: true as const,
      keep_alive: this.keepAlive,
      options: this.numCtx ? { num_ctx: this.numCtx } : undefined,
    });

    if (isAsyncIterable<ChatResponse>(response)) {
      return collectStreamingChatResponse(response, abortSignal);
    }

    return chatResponseToResult(response);
  }

  async chatOnce(
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

    return chatResponseToResult(response);
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

interface AbortableAsyncIterable<T> extends AsyncIterable<T> {
  abort?: () => void;
}

function isAsyncIterable<T>(value: unknown): value is AbortableAsyncIterable<T> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function collectStreamingChatResponse(
  stream: AbortableAsyncIterable<ChatResponse>,
  abortSignal?: AbortSignal,
): Promise<ChatResult> {
  let content = '';
  let role = 'assistant';
  const toolCalls: ToolCall[] = [];
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalDurationNs: 0 };
  const abort = (): void => stream.abort?.();

  if (abortSignal?.aborted) abort();
  abortSignal?.addEventListener('abort', abort, { once: true });

  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) throw new Error('aborted');
      if (chunk.message?.role) role = chunk.message.role;
      content += chunk.message?.content ?? '';
      if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
      usage = {
        promptTokens: chunk.prompt_eval_count ?? usage.promptTokens,
        completionTokens: chunk.eval_count ?? usage.completionTokens,
        totalDurationNs: chunk.total_duration ?? usage.totalDurationNs,
      };
    }
  } finally {
    abortSignal?.removeEventListener('abort', abort);
  }

  const message: Message = { role, content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { message, usage };
}

function chatResponseToResult(response: ChatResponse): ChatResult {
  return {
    message: response.message,
    usage: {
      promptTokens: response.prompt_eval_count ?? 0,
      completionTokens: response.eval_count ?? 0,
      totalDurationNs: response.total_duration ?? 0,
    },
  };
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

export async function longLivedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const body = toRequestBody(init.body);
  const headers = normalizeFetchHeaders(init.headers);
  if (body && !hasHeader(headers, 'content-length')) headers['Content-Length'] = String(body.length);

  return new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(url, {
      method: init.method ?? 'GET',
      headers,
    }, (response) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          response.on('end', () => controller.close());
          response.on('error', (error) => controller.error(error));
        },
        cancel() {
          request.destroy();
        },
      });

      resolve(new Response(stream, {
        status: response.statusCode ?? 0,
        statusText: response.statusMessage,
        headers: response.headers as unknown as Record<string, string>,
      }));
    });

    request.setTimeout(0);
    request.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) {
        request.destroy(new Error('aborted'));
      } else {
        init.signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
      }
    }
    if (body) request.write(body);
    request.end();
  });
}

function normalizeFetchHeaders(headers: RequestInit['headers'] | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => { normalized[key] = value; });
    return normalized;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function toRequestBody(body: RequestInit['body'] | null | undefined): Buffer | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error('Unsupported Ollama request body type');
}
