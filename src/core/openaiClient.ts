import type { Message, Tool, ToolCall } from 'ollama';
import { appendFileSync } from 'fs';
import type { ChatResult, IChatClient, StreamChunk, TokenUsage } from './chatClient';
import { liftInlineToolCalls } from './ollamaClient';

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
  /** Bearer token for Authorization header. */
  apiKey: string;
  /** Provider model id, e.g. gpt-oss-120b or gpt-4.1 */
  model: string;
  /** Optional fallback context window (rarely served by these APIs). */
  contextWindow?: number;
  /** Per-request timeout in milliseconds (default 120s). */
  timeoutMs?: number;
  /** Identifier surfaced in errors / debug logs. */
  providerLabel?: string;
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
}

export class OpenAIClient implements IChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly contextWindow?: number;
  private readonly timeoutMs: number;
  private readonly providerLabel: string;

  constructor(config: OpenAIClientConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAIClient requires an apiKey.');
    }
    if (!config.baseUrl) {
      throw new Error('OpenAIClient requires a baseUrl.');
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.contextWindow = config.contextWindow;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.providerLabel = config.providerLabel ?? 'openai-compatible';
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
   * Single-event "stream" — collect the full response and yield it as one
   * chunk. The agent loop already handles non-streaming gracefully and the
   * UI does not depend on token-by-token streaming for OpenAI-compatible
   * backends today.
   */
  async *chatStream(messages: Message[], tools?: Tool[]): AsyncGenerator<StreamChunk> {
    const result = await this.invoke(messages, tools);
    yield {
      content: typeof result.message.content === 'string' ? result.message.content : '',
      done: true,
      toolCalls: result.message.tool_calls,
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
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      stream: false,
    };
    if (extras.maxTokens) body.max_tokens = extras.maxTokens;
    if (tools && tools.length > 0) body.tools = tools.map(toOpenAITool);

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.providerLabel} request failed: ${message}`);
    } finally {
      clearTimeout(timeoutHandle);
    }

    const elapsedNs = (Date.now() - startedAt) * 1_000_000;

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as OpenAIErrorResponse;
        detail = errBody.error?.message ?? '';
      } catch {
        try { detail = await response.text(); } catch { /* ignore */ }
      }
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
}

// --- Translation helpers ---

function toOpenAIMessage(msg: Message): Record<string, unknown> {
  // OpenAI uses `tool_calls` on assistant messages and a `tool_call_id` on
  // role:tool messages. Ollama's role:tool messages do not carry an id, so
  // we synthesize one when needed.
  const out: Record<string, unknown> = { role: msg.role };
  if (msg.content !== undefined && msg.content !== null) out.content = msg.content;
  if (msg.tool_calls?.length) {
    out.tool_calls = msg.tool_calls.map((tc, i) => ({
      id: (tc as { id?: string }).id ?? `call_${i}`,
      type: 'function',
      function: {
        name: tc.function?.name ?? '',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
      },
    }));
  }
  if (msg.role === 'tool' && !(out as { tool_call_id?: string }).tool_call_id) {
    (out as Record<string, unknown>).tool_call_id = (msg as { tool_call_id?: string }).tool_call_id ?? 'call_unknown';
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
      }
    } catch {
      // OpenAI sometimes returns invalid JSON args; fall back to empty.
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
