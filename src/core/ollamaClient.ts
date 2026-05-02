import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse, Message, Tool, ToolCall } from 'ollama';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { appendFileSync } from 'fs';
import type { ChatResult, IChatClient, StreamChunk, TokenUsage } from './chatClient';

export type { ChatResult, StreamChunk, TokenUsage } from './chatClient';

export interface OllamaClientConfig {
  host?: string;
  model: string;
  keepAlive?: string;
  numCtx?: number;
}

export class OllamaClient implements IChatClient {
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

    let result: ChatResult;
    if (isAsyncIterable<ChatResponse>(response)) {
      result = await collectStreamingChatResponse(response, abortSignal);
    } else {
      result = chatResponseToResult(response);
    }
    writeDebugLog(this.model, messages, tools, result);
    return result;
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
  liftInlineToolCalls(message);
  return { message, usage };
}

function chatResponseToResult(response: ChatResponse): ChatResult {
  const message: Message = response.message;
  liftInlineToolCalls(message);
  return {
    message,
    usage: {
      promptTokens: response.prompt_eval_count ?? 0,
      completionTokens: response.eval_count ?? 0,
      totalDurationNs: response.total_duration ?? 0,
    },
  };
}

/**
 * Append the raw chat exchange to HARNESS_DEBUG_LOG when the env var is
 * set. Each entry is a single-line JSON record so the file is JSONL and
 * trivially greppable. Disabled (free) when the env is unset, which keeps
 * production runs zero-overhead.
 */
function writeDebugLog(model: string, messages: Message[], tools: Tool[] | undefined, result: ChatResult): void {
  const debugPath = process.env.HARNESS_DEBUG_LOG;
  if (!debugPath) return;
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      model,
      messageCount: messages.length,
      lastUserMessage: typeof messages[messages.length - 1]?.content === 'string'
        ? (messages[messages.length - 1].content as string).slice(0, 500)
        : null,
      toolNames: tools?.map((t) => t.function?.name).filter(Boolean) ?? [],
      response: {
        role: result.message.role,
        content: typeof result.message.content === 'string' ? result.message.content.slice(0, 2000) : null,
        toolCalls: result.message.tool_calls?.map((tc) => ({
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        })) ?? [],
      },
      usage: result.usage,
    };
    appendFileSync(debugPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // best-effort; debug logging must never break the main flow
  }
}

/**
 * Some Ollama models (notably qwen2.5-coder, several gemma variants, and
 * older deepseek builds) ignore the structured `tool_calls` field and emit
 * tool invocations as JSON inside `message.content`. The agent loop only
 * dispatches when `message.tool_calls` is populated, so without this lift
 * the harness sees a chatty model and stops after one turn.
 * This function scans `message.content` for objects shaped like
 * `{ "name": "...", "arguments": {...} }` (also accepting the OpenAI
 * `function_call` shape) and promotes them to `message.tool_calls`. It
 * preserves any pre-existing structured tool_calls, never throws on
 * malformed JSON, and removes only the matched JSON spans from the
 * surfaced text content so the UI does not double-render the call.
 */
export function liftInlineToolCalls(message: Message | undefined): void {
  if (!message || message.tool_calls?.length) return;
  const text = typeof message.content === 'string' ? message.content : '';
  if (!text || (text.indexOf('"name"') === -1 && text.indexOf('"function"') === -1)) return;

  const lifted: ToolCall[] = [];
  const removalSpans: Array<[number, number]> = [];

  for (const span of findJsonObjectSpans(text)) {
    const candidate = text.slice(span[0], span[1] + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const call = coerceToolCall(parsed);
    if (call) {
      lifted.push(call);
      removalSpans.push(span);
    }
  }

  if (lifted.length === 0) return;
  message.tool_calls = lifted;

  // Strip lifted JSON (and surrounding ```json fences) from the visible content.
  let cleaned = text;
  for (let i = removalSpans.length - 1; i >= 0; i--) {
    const [start, end] = removalSpans[i];
    let dropStart = start;
    let dropEnd = end + 1;
    const before = cleaned.slice(Math.max(0, start - 16), start);
    const fenceBefore = before.match(/```(?:json)?\s*$/);
    if (fenceBefore) dropStart = start - fenceBefore[0].length;
    const after = cleaned.slice(dropEnd, dropEnd + 16);
    const fenceAfter = after.match(/^\s*```/);
    if (fenceAfter) dropEnd += fenceAfter[0].length;
    cleaned = cleaned.slice(0, dropStart) + cleaned.slice(dropEnd);
  }
  message.content = cleaned.trim();
}

/** Find balanced `{...}` spans at the top level of `text`. */
function findJsonObjectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        spans.push([start, i]);
        start = -1;
      }
      if (depth < 0) { depth = 0; start = -1; }
    }
  }
  return spans;
}

/** Accept either `{name, arguments}` or `{function: {name, arguments}}`. */
function coerceToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  let name: unknown = obj.name;
  let args: unknown = obj.arguments ?? obj.parameters ?? obj.args;

  if (!name && obj.function && typeof obj.function === 'object') {
    const fn = obj.function as Record<string, unknown>;
    name = fn.name;
    args = fn.arguments ?? fn.parameters ?? args;
  }

  if (typeof name !== 'string' || !name) return null;

  let parsedArgs: Record<string, unknown> = {};
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    parsedArgs = args as Record<string, unknown>;
  } else if (typeof args === 'string' && args.trim()) {
    try {
      const maybe = JSON.parse(args);
      if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
        parsedArgs = maybe as Record<string, unknown>;
      }
    } catch {
      // leave as empty
    }
  }

  return { function: { name, arguments: parsedArgs as Record<string, any> } } as ToolCall;
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
