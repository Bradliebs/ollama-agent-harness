import type { Message, Tool } from 'ollama';
import type { IChatClient } from '../core/chatClient';

/**
 * Active verification of whether a selected model actually emits tool calls.
 *
 * The harness already infers tool-use capability from model name patterns
 * (see inferModelCapabilities). That is a *prior*, not proof: many local
 * models (small Gemma/Qwen variants, quantised builds) silently fail to call
 * tools — they emit the tool JSON as plain assistant text, or ignore the
 * tools entirely and loop. The user then blames the product for a model
 * limitation. This probe sends one trivial tool to the model and checks
 * whether a real tool_call comes back, so the harness can warn *before* the
 * first failed run instead of after.
 */

export type ToolCallProbeVerdict = 'verified' | 'failed' | 'inconclusive';

export interface ToolCallProbeResult {
  /** Model the probe ran against. */
  model: string;
  /** verified = emitted a tool call; failed = ignored the tool; inconclusive = error/timeout. */
  verdict: ToolCallProbeVerdict;
  /** True only when the model returned at least one tool_call. */
  calledTool: boolean;
  /** Name of the tool the model called, when available. */
  toolName?: string;
  /** Human-readable explanation suitable for surfacing in readiness/UI. */
  message: string;
  /** Wall-clock duration of the probe in milliseconds. */
  durationMs: number;
  /** ISO timestamp of when the probe completed. */
  checkedAt: string;
}

export interface ToolCallProbeOptions {
  /** Abort the probe after this many ms (verdict becomes inconclusive). Default 20s. */
  timeoutMs?: number;
}

export const PROBE_TOOL_NAME = 'report_ready';

const PROBE_TOOL: Tool = {
  type: 'function',
  function: {
    name: PROBE_TOOL_NAME,
    description: 'Acknowledge readiness. Call this tool to confirm you can call tools.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: "Set to 'ok'." },
      },
      required: ['status'],
    },
  },
};

const PROBE_MESSAGES: Message[] = [
  {
    role: 'system',
    content:
      'You are a tool-using assistant. When a tool is provided you MUST call it instead of replying with plain text.',
  },
  {
    role: 'user',
    content: `Call the ${PROBE_TOOL_NAME} tool now with status set to "ok". Do not reply with any text.`,
  },
];

const DEFAULT_TIMEOUT_MS = 20_000;

function safeGetModel(client: IChatClient): string {
  try {
    return client.getModel() || 'model';
  } catch {
    return 'model';
  }
}

function buildResult(
  model: string,
  verdict: ToolCallProbeVerdict,
  calledTool: boolean,
  toolName: string | undefined,
  message: string,
  startedAt: number,
): ToolCallProbeResult {
  return { model, verdict, calledTool, toolName, message, durationMs: Date.now() - startedAt, checkedAt: new Date().toISOString() };
}

/**
 * Run a single trivial tool-call against the model and classify the outcome.
 * Pure with respect to the harness: it only touches the provided client, so it
 * is fully exercisable with a mock IChatClient in tests.
 */
export async function probeToolCalling(client: IChatClient, options: ToolCallProbeOptions = {}): Promise<ToolCallProbeResult> {
  const model = safeGetModel(client);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await client.chat(PROBE_MESSAGES, [PROBE_TOOL], controller.signal);
    const toolCalls = result.message?.tool_calls ?? [];
    if (toolCalls.length > 0) {
      const named = toolCalls.find((call) => call?.function?.name);
      const toolName = named?.function?.name;
      return buildResult(
        model,
        'verified',
        true,
        toolName,
        `${model} called a tool (${toolName ?? 'unnamed'}) — tool calling works.`,
        startedAt,
      );
    }
    return buildResult(
      model,
      'failed',
      false,
      undefined,
      `${model} ignored the provided tool and replied with text. It may emit tool calls as plain text or not support tool calling. For research, file, or automation tasks, pick a model with verified tool support.`,
      startedAt,
    );
  } catch (err) {
    const reason = controller.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error ? err.message : String(err);
    return buildResult(model, 'inconclusive', false, undefined, `Could not verify tool calling for ${model}: ${reason}.`, startedAt);
  } finally {
    clearTimeout(timer);
  }
}
