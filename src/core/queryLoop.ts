import type { Message } from 'ollama';
import { existsSync } from 'fs';
import * as path from 'path';
import { OllamaClient } from './ollamaClient';
import type { IChatClient } from './chatClient';
import type { Tool, ToolCall, LoopConfig, LoopEvent } from '../types';
import { toolToSchema } from '../types/tool';
import { renderTaskContractBlock } from '../types/taskContract';
import type { HookPipeline } from '../extensibility/hookPipeline';
import { compactIfNeeded, DEFAULT_COMPACTION_CONFIG } from '../context/compaction';
import { estimateTokenCount } from '../context/assembly';
import type { SessionStorage } from '../persistence/sessionStorage';
import { createContinuityCheckpoint } from '../persistence/continuity';
import { ToolDispatcher } from '../tools/dispatcher';
import { runWithSessionId } from '../tools/sessionContext';
import { ReadBeforeWriteGate } from '../tools/readBeforeWriteGate';
import { buildInspectorsFromEnv, type AdversaryJudge } from '../safety/toolInspectors';
import { renderRepoMapBlock } from './repoMap';
import { scanForInjection } from '../safety/injectionDefence';
import type { LearningRecorder } from '../learning/engine';
import type { RuntimeTracer } from './tracing';
import type { SideEffectRecorder } from '../persistence/sideEffectRecording';
import { validateOutput, withOutputValidationInstructions, detectSelfCertification } from './outputValidation';
import type { OutputValidationProfile } from './outputValidation';
import { formatUnverifiedFooter, verifyPathClaims } from './pathClaims';
import { verifyCode } from './doneStateVerifier';
import { classifyModelLocality } from '../observability/costProvenance';

/**
 * Resolve whether post-completion code verification should run.
 * Precedence: HARNESS_VERIFY env override > explicit config.verify.enabled >
 * auto-detect (only when `cwd` is supplied). The shared loop calls this WITHOUT
 * a cwd, so the primitive stays off unless a caller opts in — keeping unit tests
 * and non-coding sessions untouched. The CLI coding-task runner passes its
 * project directory so real coding tasks are verified by default (a directory
 * with package.json counts as a code project). Callers force it off with
 * verify.enabled=false or HARNESS_VERIFY=0.
 */
export function resolveVerifyEnabled(explicit: boolean | undefined, cwd?: string): boolean {
  const env = process.env.HARNESS_VERIFY?.toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') return false;
  if (env === '1' || env === 'on' || env === 'true') return true;
  if (explicit !== undefined) return explicit;
  return cwd !== undefined && existsSync(path.join(cwd, 'package.json'));
}

export interface QueryLoopDeps {
  client: IChatClient;
  tools: Tool[];
  permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>;
  hooks?: HookPipeline;
  session?: SessionStorage;
  summarizerClient?: IChatClient;
  tracer?: RuntimeTracer;
  /** Per-session, project-scoped recorder. Passed through to the dispatcher
   * so tool usage is logged under the caller's PROJECT_DIR and sessionId
   * instead of the legacy default recorder bound to `process.cwd()`. */
  learningRecorder?: LearningRecorder;
  /** When set, file-mutating tool calls record reversible side effects under
   * this run id so the whole run can be undone. The caller owns the run
   * boundary (e.g. a goal scopes all its iterations under one id). */
  sideEffectRecorder?: SideEffectRecorder;
  /**
   * Optional LLM-backed judge wired into AdversaryInspector. Constructed by
   * the caller (e.g. `createLlmAdversaryJudge(client)`) so the inspector
   * module stays provider-free. Only consulted when
   * `HARNESS_INSPECTOR_ADVERSARY=1` AND `.harness/adversary.md` exists.
   */
  adversaryJudge?: AdversaryJudge;
  /**
   * Called when a safety inspector requires human confirmation before a
   * tool runs. Return `true` to proceed, `false` to abort. Without this,
   * `requireApproval` decisions silently pass through (matches goose CLI).
   */
  onApprovalRequired?: (info: {
    call: ToolCall;
    reason: string;
    warning?: string;
    inspectorName: string;
  }) => Promise<boolean>;
}

export async function* queryLoop(
  config: LoopConfig,
  deps: QueryLoopDeps,
  initialMessages: Message[] = [],
): AsyncGenerator<LoopEvent> {
  const { maxTurns, abortSignal } = config;
  const { client, tools, permissionCheck, hooks, session, summarizerClient, tracer, learningRecorder, sideEffectRecorder, adversaryJudge, onApprovalRequired } = deps;

  // Authoritative cost-honesty signal for this run: the serving client knows
  // whether it runs on-box (Ollama → 'local', $0 marginal) or hosted. Fall
  // back to registry classification when the client predates getLocality;
  // the model name alone can't tell apart off-registry local pulls, so the
  // client signal is preferred.
  const runLocality = client.getLocality?.() ?? classifyModelLocality(config.model);

  const dispatcher = new ToolDispatcher(tools);
  const readBeforeWriteGate = config.readBeforeWrite?.mode && config.readBeforeWrite.mode !== 'off'
    ? new ReadBeforeWriteGate({
        mode: config.readBeforeWrite.mode,
        exemptPaths: config.readBeforeWrite.exemptPaths,
        allowNewFiles: config.readBeforeWrite.allowNewFiles,
      })
    : undefined;
  const ollamaTools = tools.map(toolToSchema);

  const validationProfile = config.outputValidation?.profile ?? 'oracle-prime';
  const customValidationProfiles = config.outputValidation?.customProfiles ?? [];

  // Prepend repo map block (framework/commands/do-not-edit snapshot) when provided.
  const withRepoMap = config.repoMap
    ? `${renderRepoMapBlock(config.repoMap)}\n\n---\n\n${config.systemPrompt}`
    : config.systemPrompt;

  // Prepend task contract block when provided so the model always sees
  // the goal, constraints, and blocked paths at the top of the system prompt.
  const baseSystemPrompt = config.taskContract
    ? `${renderTaskContractBlock(config.taskContract)}\n\n---\n\n${withRepoMap}`
    : withRepoMap;

  const systemPrompt = config.outputValidation?.enabled
    ? withOutputValidationInstructions(baseSystemPrompt, validationProfile, customValidationProfiles)
    : baseSystemPrompt;

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...initialMessages,
  ];

  // The user's active instruction: the last genuine user message present
  // before the loop starts injecting its own continuation/nudge messages.
  // Pinning it keeps the real objective in front of the model across
  // auto-continue relaunches and in the trimmed synthesis context — without
  // it, a loop-injected stub becomes the "last user message" and the goal
  // silently evaporates (the cause of goal-drift on resumed/continued runs).
  const originalGoal = [...initialMessages].reverse().find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0,
  )?.content as string | undefined;

  let turn = 0;

  // ── Injection defence scan ──────────────────────────────────────────
  // Scan user messages before they reach the model. In block mode, yield
  // an error and stop if a high-confidence injection is detected.
  if (config.injectionDefence?.mode && config.injectionDefence.mode !== 'off') {
    for (const msg of initialMessages) {
      if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
      const scan = scanForInjection(msg.content, {
        mode: config.injectionDefence.mode,
        blockThreshold: config.injectionDefence.blockThreshold,
      });
      if (scan.flagged) {
        yield { type: 'error', message: `⚠️  ${scan.summary}`, recoverable: !scan.blocked } as LoopEvent;
        if (scan.blocked) {
          yield { type: 'done', reason: 'error', turns: 0 } as LoopEvent;
          return;
        }
      }
    }
  }

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
  const allToolCallNames: string[] = [];
  let autoContinueCount = 0;
  const autoContinueLimit = config.autoContinueLimit ?? 5;
  const loopStarted = Date.now();
  const timeBudgetMs = config.maxTimeMs ?? 0;
  let lastAssistantFingerprint = '';
  let consecutiveRepeats = 0;
  const REPETITION_LIMIT = 2;
  // Set when the model ends a turn with empty text after tools ran this run.
  // Routes into the synthesis path instead of accepting an empty `completed`.
  let emptyFinalAfterTools = false;
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
          locality: runLocality,
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
        // content may be null or an array of content blocks (reasoning/multimodal
        // shapes from some providers); detectPartialResult expects a plain string.
        const text = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
        const reason = detectPartialResult(text);
        if (reason) {
          autoContinueCount++;
          yield { type: 'text', content: text };
          yield { type: 'auto_continue', turn, continuationCount: autoContinueCount, reason };
          tracer?.recordEvent('auto_continue', { turn, count: autoContinueCount, reason, taskType: config.taskType });
          const continuationBody = 'Continue with all suggestions. Do not stop to ask — complete everything autonomously. Read all relevant files, do all analysis steps, and provide a comprehensive final result.';
          messages.push({
            role: 'user',
            content: originalGoal
              ? `${continuationBody}\n\nReminder — the original task you must complete is:\n${originalGoal}`
              : continuationBody,
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

      // Empty-final-turn guard: some local models (e.g. Gemma) end a run by
      // returning an empty text turn after tools have already produced data,
      // instead of writing an answer. Accepting that as `completed` leaves the
      // UI to show a "model did not write a final answer" fallback. Route into
      // the existing synthesis path (tools stripped, "write your answer") so
      // the gathered tool results are actually turned into a reply.
      const finalContentIsEmpty = assistantMessage.content == null
        || (typeof assistantMessage.content === 'string' && assistantMessage.content.trim() === '');
      if (finalContentIsEmpty && totalToolCalls > 0) {
        emptyFinalAfterTools = true;
        yield { type: 'synthesis_fired', model: config.model, maxTurns, toolCallsTotal: totalToolCalls };
        tracer?.recordEvent('synthesis.empty_after_tools', { model: config.model, turn, totalToolCalls });
        break;
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

      // Self-certification check: detect claims the agent makes that
      // have no supporting tool evidence. E.g. "email sent ✅" without
      // any email/notification tool call in the trace.
      const selfCertFindings = detectSelfCertification(assistantMessage.content ?? '', allToolCallNames);
      if (selfCertFindings.length > 0) {
        for (const finding of selfCertFindings) {
          yield {
            type: 'output_validation',
            validation: {
              profile: 'self-certification' as OutputValidationProfile,
              status: finding.severity,
              score: finding.severity === 'fail' ? 0.3 : 0.6,
              findings: [{
                code: `self-cert-${finding.claimType}`,
                severity: finding.severity,
                message: finding.message,
              }],
              missingSections: [],
            },
          };
        }
        tracer?.recordEvent('self_certification.detected', {
          findings: selfCertFindings.length,
          types: selfCertFindings.map((f) => f.claimType),
        });
      }

      if (session) {
        await appendStatus(session, 'completed', undefined, tracer);
      }

      // Post-completion code verification: runs tsc / eslint / npm test when
      // the agent mutated files. The shared loop defaults off (env override or
      // explicit config required); the CLI coding-task runner opts in via
      // verify.enabled so real coding tasks are verified by default. This is
      // Gap 1 — catching regressions introduced by agent edits instead of
      // trusting that files merely changed.
      let testsFailed = false;
      if (resolveVerifyEnabled(config.verify?.enabled) && anyProductiveToolSucceeded) {
        try {
          const verifyResult = await verifyCode({
            projectDir: process.cwd(),
            quick: config.verify?.quick ?? false,
            timeout: config.verify?.timeout ?? 60_000,
          });
          tracer?.recordEvent('verification.complete', {
            overall: verifyResult.overall,
            checks: verifyResult.checks.length,
          });
          yield {
            type: 'verification',
            overall: verifyResult.overall,
            checks: verifyResult.checks,
          };
          testsFailed = verifyResult.overall === 'fail';
        } catch (verifyErr) {
          const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          tracer?.recordEvent('verification.error', { error: msg });
        }
      }

      yield {
        type: 'done',
        reason: testsFailed
          ? 'completed_with_test_failures'
          : validationFailed
            ? 'completed_with_validation_failures'
            : 'completed',
        turns: turn,
      };
      return;
    }

    // Parse tool calls from the assistant message
    const toolCalls: ToolCall[] = assistantMessage.tool_calls.map((tc) => ({
      id: (tc as { id?: string }).id,
      name: tc.function.name,
      input: (tc.function.arguments && typeof tc.function.arguments === 'object' && !Array.isArray(tc.function.arguments) ? tc.function.arguments : {}) as Record<string, unknown>,
    }));
    totalToolCalls += toolCalls.length;
    for (const tc of toolCalls) allToolCallNames.push(tc.name);

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

    const compressOutput = process.env.HARNESS_TOOL_COMPRESSION_ENABLED !== '0';
    const compressionConfig = process.env.HARNESS_TOOL_COMPRESSION_MAX_CHARS
      ? { maxChars: Number(process.env.HARNESS_TOOL_COMPRESSION_MAX_CHARS) || undefined }
      : undefined;
    const { manager: inspectors, largeResponseConfig } = buildInspectorsFromEnv({ adversaryJudge });
    const dispatchedToolResults = await runWithSessionId(session?.getSessionId(), () =>
      dispatcher.dispatch(dispatchableToolCalls, permissionCheck, undefined, { hooks, trackUsage: true, tracer, learningRecorder, readBeforeWriteGate, compressOutput, compressionConfig, sideEffectRecorder, inspectors, largeResponseConfig, onApprovalRequired }));
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
          // Use 'user' role: Mistral and Anthropic reject 'system' after 'tool'.
          messages.push({ role: 'user', content: warning } as Message);
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

    // Empty-result auto-retry: when a tool (typically bash running a
    // scanner/query) returns output indicating zero matches, nudge the
    // model to widen filters or iterate. This prevents the agent from
    // presenting "0 results" to the user without trying alternatives.
    if (config.autoContinue && turn < maxTurns) {
      const lastToolOutput = toolResults.length > 0 ? String(toolResults[toolResults.length - 1].result.output ?? '') : '';
      const emptyResultReason = detectEmptyResult(lastToolOutput);
      if (emptyResultReason) {
        // Use 'user' role: Mistral and Anthropic reject 'system' after 'tool'.
        messages.push({
          role: 'user',
          content: `⚠️ The last tool returned empty or zero results (${emptyResultReason}). Do NOT present this to the user as a final answer. Instead: widen filters, relax thresholds, try alternative data sources, or explain why no results are available and suggest next steps.`,
        } as Message);
        tracer?.recordEvent('empty_result.nudge', { turn, reason: emptyResultReason });
      }
    }
  }

  // Max turns, time budget, or repetition reached — grant a bonus synthesis
  // turn with tools stripped so the model MUST produce a text response
  // summarising its work.
  const timeBudgetExceeded = timeBudgetMs > 0 && (Date.now() - loopStarted) >= timeBudgetMs;
  const repetitionExceeded = consecutiveRepeats >= REPETITION_LIMIT;
  const synthesisReason: 'max_turns_synthesized' | 'time_budget_synthesized' | 'repetition_synthesized' | 'empty_after_tools_synthesized' =
    emptyFinalAfterTools ? 'empty_after_tools_synthesized'
      : repetitionExceeded ? 'repetition_synthesized'
        : timeBudgetExceeded ? 'time_budget_synthesized'
          : 'max_turns_synthesized';
  const sessionStatus = emptyFinalAfterTools ? 'completed' : repetitionExceeded ? 'error' : timeBudgetExceeded ? 'time_budget' : 'max_turns';

  if (!timeBudgetExceeded && !repetitionExceeded && !emptyFinalAfterTools) {
    // Only emit synthesis_fired for max-turns (time budget, repetition, and
    // empty-after-tools already emitted it above before breaking).
    yield { type: 'synthesis_fired', model: config.model, maxTurns, toolCallsTotal: totalToolCalls };
    tracer?.recordEvent('synthesis.fired', { model: config.model, maxTurns, totalToolCalls });
  }

  // Build a concrete synthesis prompt with the last few tool results
  // so small models (gemma4:e4b, etc.) have the data right in front
  // of them instead of needing to recall it from deep context.
  // Keep enough of each result (2500 chars) that the actual payload —
  // headlines, prices, article body — survives. A 500-char cut often
  // showed only a page's nav/boilerplate prefix (e.g. "Skip to content"),
  // leaving the model to synthesise from chrome instead of content.
  const recentToolResults = messages
    .filter((m) => m.role === 'tool' && typeof m.content === 'string')
    .slice(-5)
    .map((m) => (m.content as string).slice(0, 2500))
    .join('\n---\n');

  const synthesisPreamble = emptyFinalAfterTools
    ? 'You ran tools but ended your last turn without writing an answer.'
    : 'You have used all available tool turns.';
  const synthesisInstruction = recentToolResults
    ? `${synthesisPreamble} Here is a summary of recent tool results:\n\n${recentToolResults}\n\nUsing the information above, write a helpful answer to the user's question. Do NOT call any tools. Just write your answer as plain text.`
    : `${synthesisPreamble} Provide a complete, useful text response now. Summarise everything you found. Do NOT call any tools.`;

  messages.push({
    role: 'system',
    content: synthesisInstruction,
  } as Message);

  // Build a trimmed message list for the synthesis call. The full
  // conversation can be 20k+ tokens which overwhelms small models.
  // Keep: system prompt, last user message, and synthesis instruction.
  // The synthesis instruction already contains the tool results.
  const systemMsg = messages.find((m) => m.role === 'system' && m !== messages[messages.length - 1]);
  // Prefer the pinned original goal over a reverse-scan: after auto-continue
  // or empty-result nudges, the most recent 'user' message is a loop-injected
  // stub, not the task. Synthesising against the stub is exactly how the goal
  // gets lost. Fall back to the reverse-scan only when no goal was captured.
  const lastUserMsg: Message | undefined = originalGoal
    ? ({ role: 'user', content: originalGoal } as Message)
    : [...messages].reverse().find((m) => m.role === 'user');
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
        locality: runLocality,
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

    // If the synthesis turn produced empty text (common with tool-trained
    // models like kimi-k2.6 that try to keep calling tools even when told
    // not to), build a SHORT, readable summary from the tool history so
    // the user gets useful signal instead of either an empty turn or a
    // raw page-dump wall. Mirrors the brevity of the UI buildToolOnlyFallback.
    let synthesisText = typeof synthMessage.content === 'string' ? synthMessage.content.trim() : '';
    const { pairs, writes } = buildSynthesisToolLedger(messages);
    if (!synthesisText) {
      const summarise = (p: SynthesisCallPair): string => {
        const collapsed = p.result.replace(/\s+/g, ' ').trim();
        if (!collapsed) return '';
        const target = typeof p.input.query === 'string' ? p.input.query
          : typeof p.input.url === 'string' ? p.input.url
          : typeof p.input.path === 'string' ? p.input.path
          : '';
        const label = target ? `${p.name} for "${target.slice(0, 90)}"` : p.name;
        return `${label}: ${collapsed.slice(0, 220)}${collapsed.length > 220 ? '…' : ''}`;
      };

      const switchHint = `_Use **Regenerate** to retry. Tool-trained cloud models (kimi-k2.6, smaller gemmas) often skip the synthesis step — switching to \`llama3.3\` or \`qwen2.5\` usually gives a clean written summary._`;

      if (writes.length > 0) {
        // File(s) created — that IS the deliverable. Keep it short.
        const fileList = writes.map((w) => `- \`${w.path}\`${w.bytes ? ` — ${w.bytes.toLocaleString()} chars` : ''}`).join('\n');
        synthesisText = `**✅ Created ${writes.length} file${writes.length === 1 ? '' : 's'}:**\n\n${fileList}\n\nThe model ran ${totalToolCalls} tool call${totalToolCalls === 1 ? '' : 's'} and saved the result above, but didn't write a prose summary. Open the file to view, or click **Regenerate** for a written summary.\n\n${switchHint}`;
      } else {
        // No artifact — give 4 short labelled bullets from non-trivial results.
        const bullets = Array.from(new Set(
          pairs
            .filter((p) => p.success && !SYNTHESIS_WRITE_TOOL_NAMES.has(p.name))
            .map(summarise)
            .filter(Boolean)
        )).slice(-4);
        const lead = `**The model ran ${totalToolCalls} tool call${totalToolCalls === 1 ? '' : 's'} but didn't write a final answer.**`;
        if (bullets.length > 0) {
          synthesisText = `${lead}\n\nHere is what it found from the tools:\n${bullets.map((b) => `- ${b}`).join('\n')}\n\n${switchHint}`;
        } else {
          synthesisText = `${lead}\n\nNo readable tool results remain in context. ${switchHint}`;
        }
      }
    } else if (writes.length > 0) {
      // Grounding guard: the model produced a non-empty summary, but if it
      // never references the file(s) it actually wrote this run, the summary
      // is ungrounded — a known confabulation mode where the tool-stripped
      // synthesis turn (fed only a truncated slice of context) invents a
      // narrative disconnected from what really happened (e.g. claiming an
      // empty/failed result when an .xlsx was in fact written). Prepend the
      // factual artifact list so the hallucination can't be shown as if no
      // deliverable exists. Additive — the model's text still appears below.
      const mentionsArtifact = writes.some((w) => {
        const base = (w.path.split(/[\\/]/).pop() ?? w.path).trim();
        return base.length > 0 && synthesisText.includes(base);
      });
      if (!mentionsArtifact) {
        const fileList = writes.map((w) => `- \`${w.path}\`${w.bytes ? ` — ${w.bytes.toLocaleString()} chars` : ''}`).join('\n');
        const noun = writes.length === 1 ? 'file' : 'files';
        const pron = writes.length === 1 ? 'it' : 'them';
        synthesisText = `**✅ The model wrote ${writes.length} ${noun} this run — the summary below does not mention ${pron}, so treat it with caution and open ${pron} directly:**\n\n${fileList}\n\n---\n\n${synthesisText}`;
        tracer?.recordEvent('synthesis.ungrounded_summary', { writes: writes.length, totalToolCalls });
      }
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

    // Self-certification check on synthesis output too
    const synthSelfCert = detectSelfCertification(synthesisText, allToolCallNames);
    if (synthSelfCert.length > 0) {
      for (const finding of synthSelfCert) {
        yield {
          type: 'output_validation',
          validation: {
            profile: 'self-certification' as OutputValidationProfile,
            status: finding.severity,
            score: finding.severity === 'fail' ? 0.3 : 0.6,
            findings: [{
              code: `self-cert-${finding.claimType}`,
              severity: finding.severity,
              message: finding.message,
            }],
            missingSections: [],
          },
        };
      }
      tracer?.recordEvent('synthesis.self_certification', {
        findings: synthSelfCert.length,
        types: synthSelfCert.map((f) => f.claimType),
      });
    }

    if (session) {
      await appendStatus(session, sessionStatus, undefined, tracer);
    }
    yield {
      type: 'done',
      reason: synthesisReason,
      turns: turn,
      synthesisMetadata: {
        elapsedMs: Date.now() - loopStarted,
        totalToolCalls,
        anyProductiveToolSucceeded,
        selfCertIssues: synthSelfCert.length,
      },
    };
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
  yield { type: 'done', reason: emptyFinalAfterTools ? 'empty_after_tools_synthesized' : repetitionExceeded ? 'repetition_synthesized' : timeBudgetExceeded ? 'time_budget_synthesized' : 'max_turns', turns: turn };
}

type SynthesisCallPair = { name: string; input: Record<string, unknown>; result: string; success: boolean };

const SYNTHESIS_WRITE_TOOL_NAMES = new Set(['file_write', 'file_create', 'write_file', 'write']);

/**
 * Reconstruct an ordered ledger of (tool call → result) pairs from the message
 * history, plus the subset that successfully wrote files. Used by the synthesis
 * turn both to build a deterministic fallback when the model emits no text AND
 * to detect an ungrounded summary that ignores files the model actually wrote.
 */
function buildSynthesisToolLedger(messages: Message[]): { pairs: SynthesisCallPair[]; writes: Array<{ path: string; bytes?: number }> } {
  const pairs: SynthesisCallPair[] = [];
  const pending: Array<{ name: string; input: Record<string, unknown>; id?: string }> = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const args = (tc.function.arguments && typeof tc.function.arguments === 'object' ? tc.function.arguments : {}) as Record<string, unknown>;
        pending.push({ name: tc.function.name, input: args, id: (tc as { id?: string }).id });
      }
      continue;
    }
    if (m.role === 'tool' && typeof m.content === 'string') {
      const tid = (m as { tool_call_id?: string }).tool_call_id;
      let idx = -1;
      if (tid) idx = pending.findIndex((p) => p.id === tid);
      if (idx < 0) idx = 0;
      const match = pending[idx];
      if (!match) continue;
      pending.splice(idx, 1);
      const resultText = m.content;
      const failed = /^(permission denied|error|failed|❌)/i.test(resultText.trim()) && !/saved to:/i.test(resultText);
      pairs.push({ name: match.name, input: match.input, result: resultText, success: !failed });
    }
  }

  const writes: Array<{ path: string; bytes?: number }> = [];
  for (const p of pairs) {
    if (!SYNTHESIS_WRITE_TOOL_NAMES.has(p.name) || !p.success) continue;
    const inputPath = typeof p.input.path === 'string' ? p.input.path : (typeof p.input.file === 'string' ? p.input.file : '');
    const inputContent = typeof p.input.content === 'string' ? p.input.content : '';
    const savedMatch = p.result.match(/Saved to:\s*([^\r\n]+)/i);
    const finalPath = (savedMatch ? savedMatch[1].trim() : inputPath).trim();
    if (!finalPath) continue;
    writes.push({ path: finalPath, bytes: inputContent ? inputContent.length : undefined });
  }

  return { pairs, writes };
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

  // Explicit continuation prompts: phrases where the model is STOPPING to ask
  // permission to do more pending work, instead of just doing it. These are
  // the only legitimate auto-continue triggers.
  //
  // Polite sign-offs of a COMPLETED answer ("if you want", "let me know if
  // you", "anything else", "i can also", "alternatively", "happy to help"…)
  // are deliberately NOT here: they appear on finished work and previously
  // caused goal-losing relaunches. A done task should stop cleanly.
  const continuationPhrases = [
    'would you like me to',
    'shall i continue',
    'shall i proceed',
    'want me to continue',
    'want me to proceed',
    'would you like to proceed',
    'should i go ahead',
    'should i continue',
    'should i proceed',
    'do you want me to continue',
    'do you want me to proceed',
    'what would you like me to do next',
    'let me know which',
    'ready to proceed',
  ];
  for (const phrase of continuationPhrases) {
    if (lower.includes(phrase)) {
      return `continuation prompt: "${phrase}"`;
    }
  }

  // Question mark at the very end (model is asking instead of doing). Tightened
  // to require BOTH a user-directed subject AND a continuation-intent verb, so
  // offers of optional extras ("Want me to also generate the code?") on a
  // finished answer do not trigger a relaunch — only genuine "should I keep
  // going with the pending work?" questions do.
  const trimmed = text.trim();
  if (trimmed.endsWith('?') && trimmed.length > 50) {
    const lastLine = (trimmed.split('\n').pop() ?? '').toLowerCase();
    const directedAtUser = /\b(you|shall|should|want|like me)\b/.test(lastLine);
    const continuationIntent = /\b(continue|proceed|go ahead|keep going|next step|move on|carry on)\b/.test(lastLine);
    if (directedAtUser && continuationIntent) {
      return 'ends with question asking to continue pending work';
    }
  }

  return null;
}

/**
 * Detect tool output that indicates zero results / empty matches.
 * Returns a reason string if empty, null otherwise.
 */
export function detectEmptyResult(output: string): string | null {
  if (!output || output.trim().length < 2) return null;
  const lower = output.toLowerCase().trim();

  // Explicit zero counts
  if (/\bpassing:\s*0\b/i.test(output)) return 'passing: 0';
  if (/\b0\s*(results?|matches?|items?|records?|rows?|candidates?|stocks?|hits?)\s*(found|returned|match)/i.test(output)) return 'zero results found';
  if (/\b(no|zero)\s+(results?|matches?|items?|records?|rows?|candidates?|stocks?|data)\s*(found|returned|available|exist)/i.test(output)) return 'no results available';
  if (/\b(nothing|empty)\s+(found|returned|to show|to display)/i.test(output)) return 'nothing found';

  // Common data tool patterns
  if (/^\s*\[\s*\]\s*$/.test(output)) return 'empty JSON array';
  if (/^\s*\{\s*\}\s*$/.test(output)) return 'empty JSON object';

  // CSV/table with only headers and no data rows
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 1 && /[,\t|]/.test(lines[0])) return 'header-only table (no data rows)';

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

