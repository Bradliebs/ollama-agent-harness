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
import { formatUnverifiedFooter, verifyPathClaims } from './pathClaims';

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
  // Tracks whether tools succeeded across the whole run. Used to
  // auto-promote the validation profile away from oracle-prime at the
  // end when the response is summarizing concrete tool work rather than
  // fulfilling the full Oracle reasoning contract.
  let anyProductiveToolSucceeded = false;
  let anyToolSucceeded = false;
  let totalToolCalls = 0;
  let autoContinueCount = 0;
  const autoContinueLimit = config.autoContinueLimit ?? 5;
  const loopStarted = Date.now();
  const timeBudgetMs = config.maxTimeMs ?? 0;
  let lastAssistantFingerprint = '';
  let consecutiveRepeats = 0;
  const REPETITION_LIMIT = 2;
  const blockedWebUrls = new Map<string, string>();

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

    // Wall-clock budget: when elapsed time exceeds the budget, trigger a
    // synthesis turn instead of continuing. This naturally throttles slow
    // local models while letting fast cloud APIs use more turns within the
    // same time window. Skipped on the first turn so the model always gets
    // at least one chance.
    if (timeBudgetMs > 0 && turn > 0 && (Date.now() - loopStarted) >= timeBudgetMs) {
      yield { type: 'synthesis_fired', model: config.model, maxTurns, toolCallsTotal: totalToolCalls };
      tracer?.recordEvent('synthesis.time_budget', { model: config.model, elapsedMs: Date.now() - loopStarted, timeBudgetMs, turn });
      break;
    }

    turn++;

    // Emit time budget progress so the UI can show a countdown indicator.
    if (timeBudgetMs > 0) {
      yield { type: 'time_budget_status', elapsedMs: Date.now() - loopStarted, budgetMs: timeBudgetMs, turn };
    }

    const turnStarted = Date.now();

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
    const contextBreakdown = buildContextBreakdown(messages);
    if (preCallTokenEstimate > Math.floor(contextLimit * 0.75)) {
      yield {
        type: 'context_breakdown',
        ...contextBreakdown,
        maxTokens: contextLimit,
        pressure: Math.min(1, preCallTokenEstimate / contextLimit),
      };
    }
    if (preCallTokenEstimate > contextLimit) {
      yield {
        type: 'context_warning',
        estimatedTokens: preCallTokenEstimate,
        maxTokens: contextLimit,
        message: `Context size (~${preCallTokenEstimate} tokens) exceeds the configured Harness limit (${contextLimit}). This usually comes from accumulated system context, history, and web_read results; the provider may reject the request.`,
      };
    }

    let assistantMessage: Message;
    const modelSpan = tracer?.startSpan('model.chat', { model: config.model, turn });
    try {
      const result = await client.chat(messages, ollamaTools, abortSignal);
      assistantMessage = result.message;
      modelSpan?.end('ok', {
        toolCalls: assistantMessage.tool_calls?.length ?? 0,
        // Surface token usage on the span itself so the OpenInference
        // exporter can map it to llm.token_count.* attributes.
        ...(result.usage ? {
          promptTokens: result.usage.promptTokens ?? 0,
          completionTokens: result.usage.completionTokens ?? 0,
        } : {}),
      });
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
          loadDurationMs: Math.round((result.usage.loadDurationNs ?? 0) / 1_000_000),
          promptEvalDurationMs: Math.round((result.usage.promptEvalDurationNs ?? 0) / 1_000_000),
          evalDurationMs: Math.round((result.usage.evalDurationNs ?? 0) / 1_000_000),
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

    // Repetition detection: if the model produces the same text-only
    // output twice in a row, it is stuck. Tool-call turns are excluded
    // because the model may be retrying with different results — the
    // repeatedToolFailureLimit guard handles that case separately.
    // Break to synthesis after REPETITION_LIMIT consecutive repeats.
    if (!assistantMessage.tool_calls?.length) {
      const fingerprint = assistantFingerprint(assistantMessage);
      if (fingerprint === lastAssistantFingerprint) {
        consecutiveRepeats++;
        if (consecutiveRepeats >= REPETITION_LIMIT) {
          yield {
            type: 'error',
            message: `Model is repeating itself (${consecutiveRepeats + 1} identical turns). Forcing synthesis.`,
            recoverable: true,
          };
          tracer?.recordEvent('repetition.detected', { turn, repeats: consecutiveRepeats + 1 });
          yield { type: 'synthesis_fired', model: config.model, maxTurns, toolCallsTotal: totalToolCalls };
          break;
        }
      } else {
        consecutiveRepeats = 0;
      }
      lastAssistantFingerprint = fingerprint;
    } else {
      // Tool-call turns reset the repetition tracker since tool results
      // vary and the repeatedToolFailureLimit guard covers that path.
      consecutiveRepeats = 0;
      lastAssistantFingerprint = '';
    }

    // Stop condition: text-only response (no tool calls)
    if (!assistantMessage.tool_calls?.length) {
      // Auto-continue: if enabled, the text looks like a partial result,
      // AND the task type is not high-risk (where human confirmation is required).
      const HIGH_RISK_TASKS = new Set(['safety_critical', 'financial_execution', 'medical', 'legal']);
      const isHighRisk = config.taskType ? HIGH_RISK_TASKS.has(config.taskType) : false;

      // Skip auto-continue when the model clearly cannot use tools: if
      // we already continued once and the model still hasn't made a single
      // tool call, further continuations just burn compute on local models
      // (e.g. gemma4 which chats instead of calling tools).
      const toolCapableRun = totalToolCalls > 0 || autoContinueCount === 0;
      if (config.autoContinue && !isHighRisk && toolCapableRun && autoContinueCount < autoContinueLimit && turn < maxTurns) {
        const text = assistantMessage.content ?? '';
        const reason = detectPartialResult(text);
        if (reason) {
          autoContinueCount++;
          yield { type: 'text', content: text };
          yield { type: 'auto_continue', turn, continuationCount: autoContinueCount, reason };
          tracer?.recordEvent('auto_continue', { turn, count: autoContinueCount, reason, taskType: config.taskType });
          messages.push({
            role: 'user',
            content: 'Continue with all suggestions. Do not stop to ask — complete everything autonomously. Read all relevant files, do all analysis steps, and provide a comprehensive final result.',
          } as Message);
          if (session) {
            await appendSession(session, 'user_message', {
              kind: 'message',
              message: { role: 'user', content: '[auto-continue]' },
            }, tracer);
          }
          continue;
        }
      }

      let validationFailed = false;
      if (config.outputValidation?.enabled) {
        // Auto-promote oracle-prime → coding-answer when the run actually
        // edited files. oracle-prime is the default fallback for ambiguous
        // prompts; using it on a coding session produces FAIL findings
        // for missing reasoning sections that the user never asked for.
        const promotedProfile = validationProfile === 'oracle-prime' && anyProductiveToolSucceeded
          ? 'coding-answer'
          : validationProfile === 'oracle-prime' && anyToolSucceeded
            ? 'tool-result-summary'
            : validationProfile;
        const shouldPromote = promotedProfile !== validationProfile;
        const effectiveProfile = promotedProfile;
        if (shouldPromote) {
          yield {
            type: 'output_validation_profile_promoted',
            from: 'oracle-prime',
            to: promotedProfile,
            reason: promotedProfile === 'coding-answer'
              ? 'productive tool calls succeeded during this run'
              : 'tool calls succeeded during this run',
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
      yield { type: 'turn_complete', turn, durationMs: Date.now() - turnStarted, toolCalls: 0 };
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
    totalToolCalls += toolCalls.length;

    const dispatchableToolCalls: ToolCall[] = [];
    const skippedToolResults: { call: ToolCall; result: { success: false; output: string; error: string } }[] = [];
    for (const call of toolCalls) {
      const url = normalizeWebToolUrl(call);
      const blockedReason = url ? blockedWebUrls.get(url) : undefined;
      if (blockedReason) {
        skippedToolResults.push({
          call,
          result: {
            success: false,
            output: `Skipped repeated ${call.name} for blocked URL: ${url}. Previous failure: ${blockedReason}. Choose a different search result or source instead.`,
            error: 'repeated blocked URL',
          },
        });
      } else {
        dispatchableToolCalls.push(call);
      }
    }

    const dispatchedToolResults = await dispatcher.dispatch(dispatchableToolCalls, permissionCheck, undefined, { hooks, trackUsage: true, tracer });
    const toolResults = [...skippedToolResults, ...dispatchedToolResults];
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
      const url = normalizeWebToolUrl(call);
      if (url && !result.success && isBlockedWebFailure(result.output ?? result.error)) {
        blockedWebUrls.set(url, String(result.error ?? result.output ?? 'blocked').slice(0, 120));
      }
      if (result.success) {
        toolFailureCounts.delete(call.name);
      } else if (repeatedToolFailureLimit > 0) {
        const failureCount = (toolFailureCounts.get(call.name) ?? 0) + 1;
        toolFailureCounts.set(call.name, failureCount);
        if (failureCount >= repeatedToolFailureLimit) {
          // Instead of killing the entire loop, warn the model and let it
          // continue with alternative tools. The model has browser_navigate
          // as a fallback for web_read, and web_search as a fallback for
          // web_fetch. Killing the loop here was the #1 cause of premature
          // stops on research-heavy queries where one site rate-limits.
          const warning = `⚠️ ${call.name} has failed ${failureCount} times in this run (last error: ${String(result.output ?? result.error ?? 'unknown error').slice(0, 300)}). Try a different tool or site instead.`;
          messages.push({ role: 'system', content: warning } as Message);
          yield { type: 'error', message: warning, recoverable: true };
          // Reset the counter so the model gets another chance if it
          // switches sites. If it keeps hitting the same broken tool
          // on the same site, it'll get warned again after 3 more tries.
          toolFailureCounts.set(call.name, 0);
        }
      }
      if (result.success && PRODUCTIVE_TOOLS.has(call.name)) {
        producedFileChange = true;
        anyProductiveToolSucceeded = true;
      }
      if (result.success) anyToolSucceeded = true;
    }

    // Emit per-turn wall-clock timing covering model call + tool execution.
    const turnToolCalls = assistantMessage.tool_calls?.length ?? 0;
    yield { type: 'turn_complete', turn, durationMs: Date.now() - turnStarted, toolCalls: turnToolCalls };

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

  // Max turns, time budget, or repetition reached — grant a bonus synthesis
  // turn with tools stripped so the model MUST produce a text response
  // summarising its work.
  const timeBudgetExceeded = timeBudgetMs > 0 && (Date.now() - loopStarted) >= timeBudgetMs;
  const repetitionExceeded = consecutiveRepeats >= REPETITION_LIMIT;
  const synthesisReason: 'max_turns_synthesized' | 'time_budget_synthesized' | 'repetition_synthesized' =
    repetitionExceeded ? 'repetition_synthesized' : timeBudgetExceeded ? 'time_budget_synthesized' : 'max_turns_synthesized';
  const sessionStatus = repetitionExceeded ? 'error' : timeBudgetExceeded ? 'time_budget' : 'max_turns';

  if (!timeBudgetExceeded && !repetitionExceeded) {
    // Only emit synthesis_fired for max-turns (time budget and repetition already emitted it above).
    yield { type: 'synthesis_fired', model: config.model, maxTurns, toolCallsTotal: totalToolCalls };
    tracer?.recordEvent('synthesis.fired', { model: config.model, maxTurns, totalToolCalls });
  }

  // Build a concrete synthesis prompt with the last few tool results
  // so small models (gemma4:e4b, etc.) have the data right in front
  // of them instead of needing to recall it from deep context.
  const recentToolResults = messages
    .filter((m) => m.role === 'tool' && typeof m.content === 'string')
    .slice(-5)
    .map((m) => (m.content as string).slice(0, 500))
    .join('\n---\n');

  const synthesisInstruction = recentToolResults
    ? `You have used all available tool turns. Here is a summary of recent tool results:\n\n${recentToolResults}\n\nUsing the information above, write a helpful answer to the user's question. Do NOT call any tools. Just write your answer as plain text.`
    : 'You have used all available tool turns. Provide a complete, useful text response now. Summarise everything you found. Do NOT call any tools.';

  messages.push({
    role: 'system',
    content: synthesisInstruction,
  } as Message);

  // Build a trimmed message list for the synthesis call. The full
  // conversation can be 20k+ tokens which overwhelms small models.
  // Keep: system prompt, last user message, and synthesis instruction.
  // The synthesis instruction already contains the tool results.
  const systemMsg = messages.find((m) => m.role === 'system' && m !== messages[messages.length - 1]);
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const synthInstructionMsg = messages[messages.length - 1];
  const synthMessages: Message[] = [];
  if (systemMsg) synthMessages.push(systemMsg);
  if (lastUserMsg) synthMessages.push(lastUserMsg);
  synthMessages.push(synthInstructionMsg);

  turn++;
  const synthSpan = tracer?.startSpan('model.chat', { model: config.model, turn, synthesis: true });
  try {
    const synthResult = await client.chat(synthMessages, [], abortSignal);
    const synthMessage = synthResult.message;
    synthSpan?.end('ok', {
      toolCalls: 0,
      ...(synthResult.usage ? {
        promptTokens: synthResult.usage.promptTokens ?? 0,
        completionTokens: synthResult.usage.completionTokens ?? 0,
      } : {}),
    });

    if (synthResult.usage) {
      yield {
        type: 'usage',
        model: config.model,
        turn,
        promptTokens: synthResult.usage.promptTokens ?? 0,
        completionTokens: synthResult.usage.completionTokens ?? 0,
        totalDurationMs: Math.round((synthResult.usage.totalDurationNs ?? 0) / 1_000_000),
        loadDurationMs: Math.round((synthResult.usage.loadDurationNs ?? 0) / 1_000_000),
        promptEvalDurationMs: Math.round((synthResult.usage.promptEvalDurationNs ?? 0) / 1_000_000),
        evalDurationMs: Math.round((synthResult.usage.evalDurationNs ?? 0) / 1_000_000),
      };
    }

    messages.push(synthMessage);
    if (session) {
      await appendSession(session, 'assistant_message', { kind: 'message', message: synthMessage }, tracer);
    }

    // If the synthesis turn produced empty text (common with small models
    // that try to call tools even when told not to), build a fallback
    // from the tool results so the user at least sees what was found.
    let synthesisText = typeof synthMessage.content === 'string' ? synthMessage.content.trim() : '';
    if (!synthesisText && recentToolResults) {
      synthesisText = `The model ran out of time but here is what it found:\n\n${recentToolResults}`;
    }

    // Optional path-claim verifier: when HARNESS_VERIFY_PATH_CLAIMS=1 is
    // set, scan the synthesis for file references and append a footer
    // listing any that don't exist. Targets the "model invents file
    // paths in its summary" failure mode without changing the answer
    // when claims are accurate. Off by default — purely additive.
    if (process.env.HARNESS_VERIFY_PATH_CLAIMS === '1' && synthesisText && typeof synthesisText === 'string') {
      const report = verifyPathClaims(synthesisText, process.cwd());
      const footer = formatUnverifiedFooter(report);
      if (footer) {
        synthesisText = `${synthesisText}${footer}`;
        tracer?.recordEvent('synthesis.unverified_paths', { count: report.unverified.length, paths: report.unverified.slice(0, 10) });
      }
    }

    yield { type: 'text', content: synthesisText || synthMessage.content };
    if (session) {
      await appendStatus(session, sessionStatus, undefined, tracer);
    }
    yield { type: 'done', reason: synthesisReason, turns: turn };
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    synthSpan?.fail(error);
    // Synthesis call itself failed (provider 5xx, network drop, etc.).
    // Without this fallback the user gets only an `error` event and the
    // run "needs review" — no visible answer at all. Emit the recent
    // tool results as text first so they at least see what was found
    // before the model died.
    if (recentToolResults) {
      yield {
        type: 'text',
        content: `⚠️ Synthesis call failed (${msg}). Showing the last ${Math.min(5, recentToolResults.split('\n---\n').length)} tool result(s) so the work isn't lost:\n\n${recentToolResults}`,
      };
    }
    yield { type: 'error', message: `Synthesis turn failed: ${msg}`, recoverable: false };
  }

  // Synthesis failed — fall through to hard stop.
  if (session) {
    await appendStatus(session, sessionStatus, undefined, tracer);
  }
  yield { type: 'done', reason: repetitionExceeded ? 'repetition_synthesized' : timeBudgetExceeded ? 'time_budget_synthesized' : 'max_turns', turns: turn };
}

function normalizeWebToolUrl(call: ToolCall): string | null {
  if (call.name !== 'web_read' && call.name !== 'web_fetch') return null;
  const rawUrl = call.input?.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function isBlockedWebFailure(output: unknown): boolean {
  return /HTTP\s+(401|403|407|408|409|423|429|451|500|502|503|504)\b|rate.?limit|forbidden|unauthori[sz]ed|access denied/i.test(String(output ?? ''));
}

function buildContextBreakdown(messages: Message[]): { totalTokens: number; systemTokens: number; historyTokens: number; toolResultTokens: number; currentUserTokens: number; messageCount: number } {
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
  let systemTokens = 0;
  let historyTokens = 0;
  let toolResultTokens = 0;
  let currentUserTokens = 0;

  messages.forEach((message, index) => {
    const tokens = estimateTokenCount([message]);
    if (message.role === 'system') systemTokens += tokens;
    else if (message.role === 'tool') toolResultTokens += tokens;
    else if (index === lastUserIndex && message.role === 'user') currentUserTokens += tokens;
    else historyTokens += tokens;
  });

  return {
    totalTokens: systemTokens + historyTokens + toolResultTokens + currentUserTokens,
    systemTokens,
    historyTokens,
    toolResultTokens,
    currentUserTokens,
    messageCount: messages.length,
  };
}

/**
 * Compute a stable fingerprint for an assistant message so consecutive
 * identical outputs can be detected. Covers both text-only and tool-call
 * responses. Intentionally lightweight — no crypto, just string concat.
 */
function assistantFingerprint(message: Message): string {
  const text = (typeof message.content === 'string' ? message.content : '').trim();
  const calls = (message.tool_calls ?? [])
    .map((tc) => `${tc.function?.name ?? ''}:${JSON.stringify(tc.function?.arguments ?? {})}`)
    .sort()
    .join('|');
  return `${text}|||${calls}`;
}

/**
 * Detect whether a model's text response is a partial result that asks
 * the user to continue, rather than a genuine final answer.
 * Returns a reason string if partial, or null if it looks complete.
 */
export function detectPartialResult(text: string): string | null {
  if (!text || text.length < 20) return null;
  const lower = text.toLowerCase();

  // Numbered suggestions pattern: "1. Do X\n2. Do Y" at the end
  if (/\n\s*\d+\.\s+.{5,}\n\s*\d+\.\s+.{5,}\s*$/.test(text)) {
    return 'numbered suggestions at end of response';
  }

  // Explicit continuation prompts
  const continuationPhrases = [
    'would you like me to',
    'shall i continue',
    'shall i proceed',
    'want me to continue',
    'want me to proceed',
    'let me know if you',
    'let me know which',
    'would you like to proceed',
    'should i go ahead',
    'should i continue',
    'do you want me to',
    'i can also',
    'i could also',
    'what would you like me to do next',
    'which option would you prefer',
    'ready to proceed',
    'if you want',
    'if you\'d like',
    'would you prefer',
    'just let me know',
    'happy to help with',
    'i\'d recommend',
    'here are some options',
    'here are a few options',
    'you could also',
    'another option would be',
    'alternatively',
    'what do you think',
    'does that sound good',
    'any questions',
    'need anything else',
    'anything else you',
    'is there anything else',
  ];
  for (const phrase of continuationPhrases) {
    if (lower.includes(phrase)) {
      return `continuation prompt: "${phrase}"`;
    }
  }

  // Question mark at the very end (model is asking something instead of doing)
  const trimmed = text.trim();
  if (trimmed.endsWith('?') && trimmed.length > 50) {
    // Only trigger if the last sentence is a question directed at the user
    const lastLine = trimmed.split('\n').pop() ?? '';
    const questionLower = lastLine.toLowerCase();
    if (questionLower.includes('you') || questionLower.includes('shall') ||
        questionLower.includes('should') || questionLower.includes('want') ||
        questionLower.includes('prefer') || questionLower.includes('like me')) {
      return 'ends with question directed at user';
    }
  }

  return null;
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

