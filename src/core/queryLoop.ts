import type { Message } from 'ollama';
import { OllamaClient } from './ollamaClient';
import type { IChatClient } from './chatClient';
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
  client: IChatClient;
  tools: Tool[];
  permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>;
  hooks?: HookPipeline;
  session?: SessionStorage;
  summarizerClient?: IChatClient;
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
  let unproductiveTurns = 0;
  const toolFailureCounts = new Map<string, number>();
  const PRODUCTIVE_TOOLS = new Set(['file_write', 'file_edit']);
  const unproductiveLimit = config.unproductiveTurnLimit ?? 0;
  const repeatedToolFailureLimit = config.repeatedToolFailureLimit ?? 3;
  // Tracks whether ANY productive tool succeeded across the whole run.
  // Used to auto-promote the validation profile from oracle-prime to
  // coding-answer at the end — oracle-prime expects reasoning sections
  // (REFRAME / SCENARIO MAP / etc) and FAILs on legitimate code-edit
  // sessions whose final reply is a tool-result summary.
  let anyProductiveToolSucceeded = false;

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

    // Pre-check: warn if estimated context exceeds the configured limit.
    // This catches oversized payloads before they hit a 413 from the provider.
    const preCallTokenEstimate = estimateTokenCount(messages);
    const contextLimit = config.context?.maxTokens ?? DEFAULT_COMPACTION_CONFIG.maxTokens;
    if (preCallTokenEstimate > contextLimit) {
      yield {
        type: 'context_warning',
        estimatedTokens: preCallTokenEstimate,
        maxTokens: contextLimit,
        message: `Context size (~${preCallTokenEstimate} tokens) exceeds limit (${contextLimit}). The provider may reject this request. Consider reducing message size.`,
      };
    }

    let assistantMessage: Message;
    const modelSpan = tracer?.startSpan('model.chat', { model: config.model, turn });
    try {
      const result = await client.chat(messages, ollamaTools, abortSignal);
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
      let validationFailed = false;
      if (config.outputValidation?.enabled) {
        // Auto-promote oracle-prime → coding-answer when the run actually
        // edited files. oracle-prime is the default fallback for ambiguous
        // prompts; using it on a coding session produces FAIL findings
        // for missing reasoning sections that the user never asked for.
        const shouldPromote = validationProfile === 'oracle-prime' && anyProductiveToolSucceeded;
        const effectiveProfile = shouldPromote ? 'coding-answer' : validationProfile;
        if (shouldPromote) {
          yield {
            type: 'output_validation_profile_promoted',
            from: 'oracle-prime',
            to: 'coding-answer',
            reason: 'productive tool calls succeeded during this run',
          };
        }
        const validation = validateOutput(assistantMessage.content ?? '', effectiveProfile, customValidationProfiles);
        tracer?.recordEvent('output.validation', {
          profile: validation.profile,
          status: validation.status,
          score: validation.score,
          findings: validation.findings.length,
        });
        yield { type: 'output_validation', validation };
        validationFailed = validation.status === 'fail';
      }
      yield { type: 'text', content: assistantMessage.content };
      if (session) {
        await appendStatus(session, 'completed', undefined, tracer);
      }
      yield {
        type: 'done',
        reason: validationFailed ? 'completed_with_validation_failures' : 'completed',
        turns: turn,
      };
      return;
    }

    // Parse tool calls from the assistant message
    const toolCalls: ToolCall[] = assistantMessage.tool_calls.map((tc) => ({
      id: (tc as { id?: string }).id,
      name: tc.function.name,
      input: (tc.function.arguments ?? {}) as Record<string, unknown>,
    }));

    const toolResults = await dispatcher.dispatch(toolCalls, permissionCheck, undefined, { hooks, trackUsage: true, tracer });
    let producedFileChange = false;
    for (const { call, result } of toolResults) {
      yield { type: 'tool_call', call };
      if (session) {
        await appendSession(session, 'tool_call', { kind: 'tool_call', call }, tracer);
      }
      yield { type: 'tool_result', call, result };
      if (session) {
        await appendSession(session, 'tool_result', { kind: 'tool_result', call, result }, tracer);
      }
      messages.push({ role: 'tool', content: result.output, ...(call.id ? { tool_call_id: call.id } : {}) } as Message);
      if (result.success) {
        toolFailureCounts.delete(call.name);
      } else if (repeatedToolFailureLimit > 0) {
        const failureCount = (toolFailureCounts.get(call.name) ?? 0) + 1;
        toolFailureCounts.set(call.name, failureCount);
        if (failureCount >= repeatedToolFailureLimit) {
          const message = `Stopping: ${call.name} failed ${failureCount} times in this run. Last error: ${String(result.output ?? result.error ?? 'unknown error').slice(0, 500)}`;
          if (session) {
            await appendStatus(session, 'error', message, tracer);
          }
          yield { type: 'error', message, recoverable: false };
          yield { type: 'done', reason: 'repeated_tool_failure', turns: turn };
          return;
        }
      }
      if (result.success && PRODUCTIVE_TOOLS.has(call.name)) {
        producedFileChange = true;
        anyProductiveToolSucceeded = true;
      }
    }

    // Tool-quality kill: terminate when the agent loops on non-productive
    // tools (reflect/consolidate/grep/list_files) without ever editing a
    // file. Bounded by `unproductiveTurnLimit` from LoopConfig.
    if (unproductiveLimit > 0) {
      if (producedFileChange) {
        unproductiveTurns = 0;
      } else {
        unproductiveTurns++;
        if (unproductiveTurns >= unproductiveLimit) {
          if (session) {
            await appendStatus(session, 'error', `${unproductiveTurns} consecutive unproductive turns`, tracer);
          }
          yield {
            type: 'error',
            message: `Stopping: ${unproductiveTurns} consecutive turns without file edits (limit ${unproductiveLimit}).`,
            recoverable: false,
          };
          yield { type: 'done', reason: 'unproductive', turns: turn };
          return;
        }
      }
    }
  }

  // Max turns reached — grant a bonus synthesis turn with tools stripped
  // so the model MUST produce a text response summarising its work.
  messages.push({
    role: 'system',
    content: 'You have used all available tool turns. Provide a complete, useful text response now. Summarise everything you found. Do NOT call any tools.',
  } as Message);

  turn++;
  const synthSpan = tracer?.startSpan('model.chat', { model: config.model, turn, synthesis: true });
  try {
    const synthResult = await client.chat(messages, [], abortSignal);
    const synthMessage = synthResult.message;
    synthSpan?.end('ok', { toolCalls: 0 });

    if (synthResult.usage) {
      yield {
        type: 'usage',
        model: config.model,
        turn,
        promptTokens: synthResult.usage.promptTokens ?? 0,
        completionTokens: synthResult.usage.completionTokens ?? 0,
        totalDurationMs: Math.round((synthResult.usage.totalDurationNs ?? 0) / 1_000_000),
      };
    }

    messages.push(synthMessage);
    if (session) {
      await appendSession(session, 'assistant_message', { kind: 'message', message: synthMessage }, tracer);
    }

    yield { type: 'text', content: synthMessage.content };
    if (session) {
      await appendStatus(session, 'max_turns', undefined, tracer);
    }
    yield { type: 'done', reason: 'max_turns_synthesized', turns: turn };
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    synthSpan?.fail(error);
    yield { type: 'error', message: `Synthesis turn failed: ${msg}`, recoverable: false };
  }

  // Synthesis failed — fall through to hard max_turns stop.
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

