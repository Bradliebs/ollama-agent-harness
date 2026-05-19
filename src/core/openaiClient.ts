import type { Message, Tool, ToolCall } from 'ollama';
import { appendFileSync } from 'fs';
import type { ChatResult, IChatClient, StreamChunk, TokenUsage } from './chatClient';
import { liftInlineToolCalls } from './ollamaClient';
import { recordSwallowed } from '../observability/silentFailureSink';

/**
 * OpenAI Chat Completions-compatible backend.
 *
 * Speaks the standard `/v1/chat/completions` API surface so the harness can
 * use any provider in that ecosystem (OpenAI, Cerebras, Groq, GitHub Models,
 * Mistral, OpenRouter, Together, Fireworks, etc.) without custom adapters.
 *
 * Chosen on purpose:
 *   - No SDK dependency. Plain `fetch` keeps install footprint small and
 *     avoids version skew across providers that have minor protocol drift.
 *   - Streaming is currently collected and returned as a single ChatResult,
 *     matching the OllamaClient streaming behaviour. The agent loop never
 *     consumed the partial stream events, so faking streaming here is fine.
 *   - Tool/message translation to and from Ollama's shape happens at the
 *     edges of this class so the rest of the codebase keeps using
 *     `ollama.Message` / `ollama.Tool` types without churn.
 */

export interface OpenAIClientConfig {
  /** OpenAI-compatible base URL, e.g. https://api.cerebras.ai/v1 */
  baseUrl: string;
  /** Bearer token. Single string, or comma-separated list for round-robin on 429. */
  apiKey: string | string[];
  /** Provider model id, e.g. gpt-oss-120b or gpt-4.1 */
  model: string;
  /** Optional fallback context window (rarely served by these APIs). */
  contextWindow?: number;
  /** Per-request timeout in milliseconds (default 120s). */
  timeoutMs?: number;
  /** Identifier surfaced in errors / debug logs. */
  providerLabel?: string;
  /** Max attempts on 429/5xx before surfacing the error (default 3). */
  maxRetries?: number;
  /** Initial backoff in ms; doubled per attempt. Capped at 30s. (default 2000) */
  retryBaseDelayMs?: number;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices: Array<{
    index?: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIErrorResponse {
  error?: { message?: string; type?: string; code?: string };
  detail?: unknown;
  message?: string;
}

export class OpenAIClient implements IChatClient {
  private readonly baseUrl: string;
  private readonly apiKeys: string[];
  private keyIndex = 0;
  private readonly model: string;
  private readonly contextWindow?: number;
  private readonly timeoutMs: number;
  private readonly providerLabel: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: OpenAIClientConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAIClient requires an apiKey.');
    }
    if (!config.baseUrl) {
      throw new Error('OpenAIClient requires a baseUrl.');
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKeys = Array.isArray(config.apiKey)
      ? config.apiKey.filter((k) => k && k.trim().length > 0)
      : [config.apiKey];
    if (this.apiKeys.length === 0) {
      throw new Error('OpenAIClient requires at least one non-empty apiKey.');
    }
    this.model = config.model;
    this.contextWindow = config.contextWindow;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.providerLabel = config.providerLabel ?? 'openai-compatible';
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 2000;
  }

  /** Get the active key. Rotates after retryable failures. */
  private currentKey(): string {
    return this.apiKeys[this.keyIndex % this.apiKeys.length];
  }

  /** Move to the next key in the pool. No-op when only one key configured. */
  private rotateKey(): void {
    if (this.apiKeys.length > 1) this.keyIndex++;
  }

  async chat(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): Promise<ChatResult> {
    const result = await this.invoke(messages, tools, abortSignal);
    writeDebugLog(this.providerLabel, this.model, messages, tools, result);
    return result;
  }

  async chatOnce(messages: Message[], tools?: Tool[]): Promise<ChatResult> {
    return this.chat(messages, tools);
  }

  /**
   * Real SSE streaming. Yields one StreamChunk per delta the provider
   * emits. The final chunk has done=true. Tool-call deltas are
   * accumulated by index because OpenAI streams them as fragmented JSON
   * over multiple chunks (`name` arrives once, `arguments` builds up).
   */
  async *chatStream(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(messages),
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools.map(toOpenAITool);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.currentKey()}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutHandle);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.providerLabel} stream request failed: ${message}`);
    }

    if (!response.ok) {
      clearTimeout(timeoutHandle);
      const detail = await readProviderErrorDetail(response);
      throw new Error(`${this.providerLabel} stream HTTP ${response.status}: ${detail || response.statusText}`);
    }

    if (!response.body) {
      clearTimeout(timeoutHandle);
      throw new Error(`${this.providerLabel} stream returned no body`);
    }

    // Accumulate tool-call deltas by their `index` because OpenAI sends
    // pieces of the same call across chunks: index 0 gets {name}, then
    // later chunks get {arguments: "..."} appended.
    const toolCallAccum: Map<number, { id?: string; name: string; argumentsText: string }> = new Map();
    const decoder = new TextDecoder();
    let buffer = '';

    const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by \n\n. Split on that, keep the trailing partial.
        let nlnl: number;
        while ((nlnl = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, nlnl).trim();
          buffer = buffer.slice(nlnl + 2);
          if (!frame) continue;

          // Each frame may have multiple lines; we only care about data: lines.
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let parsed: any;
            try { parsed = JSON.parse(payload); } catch { continue; }
            const delta = parsed?.choices?.[0]?.delta;
            if (!delta) continue;

            const contentDelta = typeof delta.content === 'string' ? delta.content : '';

            if (Array.isArray(delta.tool_calls)) {
              for (const tcDelta of delta.tool_calls) {
                const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
                const existing = toolCallAccum.get(idx) ?? { name: '', argumentsText: '' };
                if (tcDelta.id) existing.id = tcDelta.id;
                if (tcDelta.function?.name) existing.name = tcDelta.function.name;
                if (typeof tcDelta.function?.arguments === 'string') {
                  existing.argumentsText += tcDelta.function.arguments;
                }
                toolCallAccum.set(idx, existing);
              }
            }

            if (contentDelta) {
              yield { content: contentDelta, done: false };
            }
          }
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      reader.releaseLock();
    }

    // Emit a final done chunk carrying any accumulated tool calls.
    const finalToolCalls = Array.from(toolCallAccum.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => fromOpenAIToolCall({
        id: tc.id,
        function: { name: tc.name, arguments: tc.argumentsText },
      }));

    yield {
      content: '',
      done: true,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
    };
  }

  /**
   * The OpenAI-compatible providers we target do not expose a
   * `/v1/models` listing on the free tier in a uniform way, so this
   * returns just the configured model. Health-check uses the same value.
   */
  async listModels(): Promise<string[]> {
    return [this.model];
  }

  async getContextWindow(): Promise<number | null> {
    return this.contextWindow ?? null;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    // Cheap probe: a 1-token chat. We deliberately do not hit /v1/models
    // because some providers (Cerebras, Groq) lock that endpoint behind
    // higher tiers but allow chat freely.
    try {
      await this.invoke(
        [{ role: 'user', content: 'ping' }],
        undefined,
        undefined,
        { maxTokens: 1 },
      );
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Cannot reach ${this.providerLabel}: ${message}` };
    }
  }

  getModel(): string {
    return this.model;
  }

  private async invoke(
    messages: Message[],
    tools?: Tool[],
    abortSignal?: AbortSignal,
    extras: { maxTokens?: number } = {},
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
        messages: toOpenAIMessages(messages),
      stream: false,
    };
    if (extras.maxTokens) body.max_tokens = extras.maxTokens;
    if (tools && tools.length > 0) body.tools = tools.map(toOpenAITool);
    const bodyString = JSON.stringify(body);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
      if (abortSignal) {
        if (abortSignal.aborted) controller.abort();
        else abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.currentKey()}`,
            accept: 'application/json',
          },
          body: bodyString,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${this.providerLabel} request failed: ${message}`);
      }
      clearTimeout(timeoutHandle);

      const elapsedNs = (Date.now() - startedAt) * 1_000_000;

      // Retryable: 429 (rate limit), 502/503/504 (transient gateway errors).
      if (response.status === 429 || (response.status >= 502 && response.status <= 504)) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const backoff = retryAfter ?? Math.min(this.retryBaseDelayMs * Math.pow(2, attempt), 30_000);
        const remaining = this.maxRetries - attempt - 1;
        const detail = await readProviderErrorDetail(response);
        lastError = new Error(`${this.providerLabel} HTTP ${response.status}: ${detail || response.statusText}`);
        if (remaining <= 0) throw lastError;
        console.warn(`[OpenAIClient] ${this.providerLabel} HTTP ${response.status} (${detail.slice(0, 80) || response.statusText}); waiting ${Math.round(backoff)}ms then retrying (${remaining} attempts left, key ${this.keyIndex + 1}/${this.apiKeys.length}).`);
        // Rotate key before next attempt — useful when 429 is account-scoped
        // and the user has provisioned multiple keys for round-robin.
        this.rotateKey();
        await sleep(backoff);
        continue;
      }

      if (!response.ok) {
        const detail = await readProviderErrorDetail(response);
        throw new Error(`${this.providerLabel} HTTP ${response.status}: ${detail || response.statusText}`);
      }

      const json = (await response.json()) as OpenAIChatResponse;
      const choice = json.choices?.[0];
      if (!choice) {
        throw new Error(`${this.providerLabel} returned no choices`);
      }

      const message: Message = {
        role: choice.message.role ?? 'assistant',
        content: choice.message.content ?? '',
      };
      if (choice.message.tool_calls?.length) {
        message.tool_calls = choice.message.tool_calls.map(fromOpenAIToolCall);
      } else {
        // Some smaller models on these gateways still emit JSON tool-call
        // shapes inside content. Reuse the existing fallback parser so the
        // OpenAI backend benefits from the same robustness as Ollama.
        liftInlineToolCalls(message);
      }

      const usage: TokenUsage = {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalDurationNs: elapsedNs,
      };

      return { message, usage };
    }
    // Loop exited without returning — should not happen because the retryable
    // branch throws when remaining <= 0, but TS needs the assertion.
    throw lastError ?? new Error(`${this.providerLabel}: invoke exhausted retries`);
  }
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a Retry-After header into a millisecond delay.
 * Accepts either a delta-seconds integer or an HTTP-date.
 * Returns undefined when missing or unparseable.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  const delta = date - Date.now();
  return delta > 0 ? delta : 0;
}

async function readProviderErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as OpenAIErrorResponse;
    return stringifyProviderError(body.error?.message ?? body.detail ?? body.message);
  } catch {
    try { return await response.text(); } catch { return ''; }
  }
}

function stringifyProviderError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stringifyProviderError(item)).filter(Boolean).join('; ');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const message = stringifyProviderError(record.msg ?? record.message ?? record.error);
    const location = Array.isArray(record.loc) ? record.loc.join('.') : stringifyProviderError(record.loc);
    if (message && location) return `${location}: ${message}`;
    if (message) return message;
    return JSON.stringify(record);
  }
  return value === undefined || value === null ? '' : String(value);
}

// --- Translation helpers ---

function toOpenAIMessages(messages: Message[]): Record<string, unknown>[] {
  const pendingToolCallIds: string[] = [];
  return messages.map((msg) => {
    const converted = toOpenAIMessage(msg, pendingToolCallIds.length);
    if (msg.role === 'assistant' && Array.isArray(converted.tool_calls)) {
      pendingToolCallIds.length = 0;
      for (const call of converted.tool_calls as Array<{ id?: string }>) {
        if (call.id) pendingToolCallIds.push(call.id);
      }
    } else if (msg.role === 'tool') {
      const existing = (msg as { tool_call_id?: string }).tool_call_id;
      converted.tool_call_id = existing ?? pendingToolCallIds.shift() ?? 'call_unknown';
    }
    return converted;
  });
}

function toOpenAIMessage(msg: Message, sequence = 0): Record<string, unknown> {
  // OpenAI uses `tool_calls` on assistant messages and a `tool_call_id` on
  // role:tool messages. Ollama's role:tool messages do not carry an id, so
  // we synthesize one when needed.
  const out: Record<string, unknown> = { role: msg.role };
  if (msg.content !== undefined && msg.content !== null) out.content = msg.content;
  if (msg.tool_calls?.length) {
    out.tool_calls = msg.tool_calls.map((tc, i) => ({
      id: (tc as { id?: string }).id ?? `call_${sequence}_${i}`,
      type: 'function',
      function: {
        name: tc.function?.name ?? '',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
      },
    }));
  }
  return out;
}

function toOpenAITool(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.function?.name,
      description: tool.function?.description,
      parameters: tool.function?.parameters,
    },
  };
}

function fromOpenAIToolCall(tc: { id?: string; function: { name: string; arguments: string } }): ToolCall {
  let parsedArgs: Record<string, unknown> = {};
  if (tc.function.arguments) {
    try {
      const maybe = JSON.parse(tc.function.arguments);
      if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
        parsedArgs = maybe as Record<string, unknown>;
      } else {
        recordSwallowed('openai.fromToolCall.nonObjectArgs', new Error('Tool call arguments did not parse to an object'), {
          tool: tc.function.name,
          raw: String(tc.function.arguments).slice(0, 200),
        });
      }
    } catch (err) {
      recordSwallowed('openai.fromToolCall.parseError', err, {
        tool: tc.function.name,
        raw: String(tc.function.arguments).slice(0, 200),
      });
    }
  }
  return {
    function: {
      name: tc.function.name,
      // Cast through unknown because the ollama type insists on `any`.
      arguments: parsedArgs as unknown as Record<string, any>,
    },
    ...(tc.id ? { id: tc.id } : {}),
  } as ToolCall;
}

function writeDebugLog(
  providerLabel: string,
  model: string,
  messages: Message[],
  tools: Tool[] | undefined,
  result: ChatResult,
): void {
  const debugPath = process.env.HARNESS_DEBUG_LOG;
  if (!debugPath) return;
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      provider: providerLabel,
      model,
      messageCount: messages.length,
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
    // best-effort
  }
}
