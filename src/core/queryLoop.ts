import type { Message } from 'ollama';
import { OllamaClient } from './ollamaClient';
import type { Tool, ToolCall, LoopConfig, LoopEvent } from '../types';
import { toolToSchema } from '../types/tool';
import type { HookPipeline } from '../extensibility/hookPipeline';
import { compactIfNeeded, DEFAULT_COMPACTION_CONFIG } from '../context/compaction';
import { estimateTokenCount } from '../context/assembly';
import type { SessionStorage } from '../persistence/sessionStorage';
import { createContinuityCheckpoint } from '../persistence/continuity';
import { ToolDispatcher } from '../tools/dispatcher';
import type { RuntimeTracer } from './tracing';
import { validateOutput, withOutputValidationInstructions } from './outputValidation';

export interface QueryLoopDeps {
  client: OllamaClient;
  tools: Tool[];
  permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>;
  hooks?: HookPipeline;
  session?: SessionStorage;
  summarizerClient?: OllamaClient;
  tracer?: RuntimeTracer;
}

export async function* queryLoop(
  config: LoopConfig,
  deps: QueryLoopDeps,
  initialMessages: Message[] = [],
): AsyncGenerator<LoopEvent> {
  const { maxTurns, abortSignal } = config;
  const { client, tools, permissionCheck, hooks, session, summarizerClient, tracer } = deps;

  const dispatcher = new ToolDispatcher(tools);
  const ollamaTools = tools.map(toolToSchema);

  const validationProfile = config.outputValidation?.profile ?? 'oracle-prime';
  const customValidationProfiles = config.outputValidation?.customProfiles ?? [];
  const systemPrompt = config.outputValidation?.enabled
    ? withOutputValidationInstructions(config.systemPrompt, validationProfile, customValidationProfiles)
    : config.systemPrompt;

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...initialMessages,
  ];

  let turn = 0;

  if (session) {
    await appendStatus(session, 'running', undefined, tracer);
    await appendSession(session, 'system', { kind: 'system', content: 'Session autosave started.' }, tracer);
    for (const message of initialMessages) {
      if (message.role === 'user' || message.role === 'assistant') {
        await appendSession(session, message.role === 'assistant' ? 'assistant_message' : 'user_message', {
          kind: 'message',
          message,
        }, tracer);
      }
    }
  }

  while (turn < maxTurns) {
    if (abortSignal?.aborted) {
      if (session) {
        await appendStatus(session, 'aborted', undefined, tracer);
      }
      yield { type: 'done', reason: 'aborted', turns: turn };
      return;
    }

    turn++;

    if (config.context?.enabled !== false) {
      const compactionConfig = { ...DEFAULT_COMPACTION_CONFIG, ...config.context };
      const before = estimateTokenCount(messages);
      const compactionSpan = tracer?.startSpan('context.compaction', { beforeTokens: before, maxTokens: compactionConfig.maxTokens });
      const compacted = await compactIfNeeded(messages, compactionConfig, summarizerClient ?? client);
      if (compacted.messages !== messages && compacted.tokensFreed > 0) {
        const checkpoint = createContinuityCheckpoint({
          sessionId: session?.getSessionId() ?? 'ephemeral',
          messages,
          summary: compacted.summary ?? `${compacted.strategy} compacted ${compacted.compactedCount ?? 0} messages.`,
          strategy: compacted.strategy,
          maxTokens: compactionConfig.maxTokens,
        });
        messages.length = 0;
        messages.push(...compacted.messages);
        const hasContinuityBoundary = compacted.summary !== undefined;
        if (session && hasContinuityBoundary) {
          await appendSession(session, 'compact_boundary', {
            kind: 'compact_boundary',
            summary: checkpoint.summary,
            compactedCount: compacted.compactedCount ?? 0,
          }, tracer);
          await appendSession(session, 'continuity_checkpoint', {
            kind: 'continuity_checkpoint',
            checkpoint,
          }, tracer);
        }
        const after = estimateTokenCount(messages);
        yield {
          type: 'context',
          strategy: compacted.strategy,
          tokensFreed: Math.max(compacted.tokensFreed, before - after),
          compactedCount: compacted.compactedCount ?? 0,
          autosaved: Boolean(session && hasContinuityBoundary),
          pressure: Math.min(1, after / compactionConfig.maxTokens),
          maxTokens: compactionConfig.maxTokens,
          qualityScore: compacted.validation?.score,
          qualityPassed: compacted.validation?.passed,
        };
      }
      compactionSpan?.end('ok', { strategy: compacted.strategy, tokensFreed: compacted.tokensFreed });
    }

    let assistantMessage: Message;
    const modelSpan = tracer?.startSpan('model.chat', { model: config.model, turn });
    try {
      const result = await client.chat(messages, ollamaTools);
      assistantMessage = result.message;
      modelSpan?.end('ok', { toolCalls: assistantMessage.tool_calls?.length ?? 0 });
      // Surface per-call telemetry so the UI can render an inline footer
      // (model · tokens · latency) under each assistant turn and roll a
      // session-total HUD in the topbar.
      if (result.usage) {
        yield {
          type: 'usage',
          model: config.model,
          turn,
          promptTokens: result.usage.promptTokens ?? 0,
          completionTokens: result.usage.completionTokens ?? 0,
          totalDurationMs: Math.round((result.usage.totalDurationNs ?? 0) / 1_000_000),
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      modelSpan?.fail(error);
      if (session) {
        await appendStatus(session, 'error', msg, tracer);
      }
      yield { type: 'error', message: `Model call failed: ${msg}`, recoverable: true };
      yield { type: 'done', reason: 'error', turns: turn };
      return;
    }

    messages.push(assistantMessage);
    if (session) {
      await appendSession(session, 'assistant_message', { kind: 'message', message: assistantMessage }, tracer);
    }

    // Stop condition: text-only response (no tool calls)
    if (!assistantMessage.tool_calls?.length) {
      if (config.outputValidation?.enabled) {
        const validation = validateOutput(assistantMessage.content ?? '', validationProfile, customValidationProfiles);
        tracer?.recordEvent('output.validation', {
          profile: validation.profile,
          status: validation.status,
          score: validation.score,
          findings: validation.findings.length,
        });
        yield { type: 'output_validation', validation };
      }
      yield { type: 'text', content: assistantMessage.content };
      if (session) {
        await appendStatus(session, 'completed', undefined, tracer);
      }
      yield { type: 'done', reason: 'completed', turns: turn };
      return;
    }

    // Parse tool calls from the assistant message
    const toolCalls: ToolCall[] = assistantMessage.tool_calls.map((tc) => ({
      name: tc.function.name,
      input: (tc.function.arguments ?? {}) as Record<string, unknown>,
    }));

    const toolResults = await dispatcher.dispatch(toolCalls, permissionCheck, undefined, { hooks, trackUsage: true, tracer });
    for (const { call, result } of toolResults) {
      yield { type: 'tool_call', call };
      if (session) {
        await appendSession(session, 'tool_call', { kind: 'tool_call', call }, tracer);
      }
      yield { type: 'tool_result', call, result };
      if (session) {
        await appendSession(session, 'tool_result', { kind: 'tool_result', call, result }, tracer);
      }
      messages.push({ role: 'tool', content: result.output });
    }
  }

  // Max turns reached
  if (session) {
    await appendStatus(session, 'max_turns', undefined, tracer);
  }
  yield { type: 'done', reason: 'max_turns', turns: turn };
}

async function appendStatus(
  session: SessionStorage,
  status: Parameters<SessionStorage['markStatus']>[0],
  lastError?: string,
  tracer?: RuntimeTracer,
): Promise<void> {
  try {
    tracer?.recordEvent('session.status', { status, lastError });
    await session.markStatus(status, lastError);
  } catch {
    // Session status is helpful recovery metadata, not a reason to stop the task.
  }
}

async function appendSession(
  session: SessionStorage,
  type: Parameters<SessionStorage['append']>[0],
  data: Parameters<SessionStorage['append']>[1],
  tracer?: RuntimeTracer,
): Promise<void> {
  try {
    tracer?.recordEvent('session.append', { type });
    await session.append(type, data);
  } catch {
    // Autosave should not stop the agent from continuing the user's task.
  }
}

