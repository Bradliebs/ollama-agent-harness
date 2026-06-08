import type { ToolCall, ToolResult } from './tool';
import type { CustomOutputValidationProfile, OutputValidationProfile, OutputValidationResult } from '../core/outputValidation';
import type { TaskContract } from './taskContract';
import type { ReadBeforeWriteMode } from '../tools/readBeforeWriteGate';
import type { RepoMap } from '../core/repoMap';
import type { InjectionDefenceMode } from '../safety/injectionDefence';
import type { ModelLocality } from '../observability/costProvenance';

export interface LoopConfig {
  /**
   * Optional task contract to inject into the system prompt.
   * When present, the loop prepends a structured Task Contract block so the
   * model always sees the goal, constraints, blocked paths, and validation
   * commands regardless of how the system prompt was assembled.
   */
  taskContract?: TaskContract;
  /**
   * Lightweight project snapshot injected into the system prompt.
   * When present, the loop prepends a ## Project Snapshot block so the model
   * always knows the framework, test command, and do-not-edit paths without
   * having to discover them through tool calls.
   *
   * Build or load a map with `buildRepoMap()` / `getOrBuildRepoMap()` from
   * `src/core/repoMap`.
   */
  repoMap?: RepoMap;
  /**
   * Read-before-write gate configuration.
   * When set, every file_write / file_edit call is checked to ensure the same
   * path was read earlier in the session.
   *
   * - `off`     — disabled (default)
   * - `warn`    — logs a warning but allows the write
   * - `enforce` — blocks the write and returns an error result
   *
   * `exemptPaths` is a list of absolute paths that bypass the check (e.g.
   * auto-generated files or temp outputs the agent creates from scratch).
   * `allowNewFiles` (default true) exempts writes to paths that do not yet
   * exist on disk.
   */
  readBeforeWrite?: {
    mode: ReadBeforeWriteMode;
    exemptPaths?: string[];
    allowNewFiles?: boolean;
  };
  /**
   * Prompt injection defence.
   * Scans incoming user messages for known injection patterns before they
   * reach the model.
   *
   * - `off`   — disabled (default)
   * - `flag`  — scan and log but allow through
   * - `block` — reject the message when a high-confidence pattern matches
   *
   * `blockThreshold` (default 0.7) sets the confidence floor for blocking
   * in `block` mode; matches below this still flag but are allowed.
   */
  injectionDefence?: {
    mode: InjectionDefenceMode;
    blockThreshold?: number;
  };
  model: string;
  systemPrompt: string;
  maxTurns: number;
  /**
   * When enabled, run tsc / eslint / npm test after any coding turn that
   * produced file mutations. Surfaces the result as a `verification` event
   * and promotes the done reason to `completed_with_test_failures` when
   * tests fail. Off by default to avoid blocking non-coding sessions.
   */
  verify?: {
    enabled?: boolean;
    /** Skip lint + tests, run typecheck only. */
    quick?: boolean;
    /** Per-check timeout in ms. Default 60 000. */
    timeout?: number;
  };
  /**
   * Wall-clock budget in milliseconds. When elapsed time exceeds this
   * budget the loop triggers a synthesis turn (tools stripped, model
   * summarises its work) instead of continuing. This naturally throttles
   * slow local models while letting fast cloud APIs use more turns.
   * Set to 0 or undefined to disable.
   */
  maxTimeMs?: number;
  abortSignal?: AbortSignal;
  /**
   * Terminate the loop early when the agent runs `unproductiveTurnLimit`
   * consecutive turns without invoking a file-mutating tool
   * (file_write / file_edit). Prevents runaway sessions where the model
   * loops on reflect/consolidate/grep without ever changing code.
   * Set to 0 or undefined to disable.
   */
  unproductiveTurnLimit?: number;
  /**
   * Terminate the loop early when one tool fails repeatedly in the same run.
   * This prevents slow, opaque retries where the model keeps calling a broken
   * tool instead of telling the user what went wrong. Set to 0 to disable.
   */
  repeatedToolFailureLimit?: number;
  context?: {
    enabled?: boolean;
    maxTokens?: number;
    budgetPerToolResult?: number;
    snipThreshold?: number;
    autoCompactThreshold?: number;
    minSummaryQuality?: number;
    summarizerModel?: string;
  };
  outputValidation?: {
    enabled?: boolean;
    profile?: OutputValidationProfile;
    customProfiles?: CustomOutputValidationProfile[];
  };
  /**
   * When enabled, the loop detects partial-result text responses (numbered
   * suggestions, "would you like to continue", etc.) and automatically
   * injects a "continue with all" user message instead of stopping.
   * Prevents stop-start behavior where the model asks for confirmation
   * instead of completing the full task autonomously.
   */
  autoContinue?: boolean;
  /** Max number of auto-continues before forcing a stop. Default 5. */
  autoContinueLimit?: number;
  /**
   * Mycelium task type classification. When set, auto-continue uses this
   * to gate behavior: high-risk tasks (financial_execution, safety_critical,
   * medical, legal) disable auto-continue to force human confirmation.
   */
  taskType?: string;
  /**
   * Cost tracking configuration (Gap #5). When enabled, the loop tracks
   * token usage per turn and enforces an optional budget cap.
   */
  costTracking?: {
    enabled?: boolean;
    /** Abort the loop when cumulative estimated cost exceeds this (USD). */
    budgetUsd?: number;
    /** Override $/1K-token rates. Key = model name, value = { input, output } per 1K tokens. */
    rates?: Record<string, { input: number; output: number }>;
  };
}

export type LoopEvent =
  | TextEvent
  | OutputValidationEvent
  | OutputValidationProfilePromotedEvent
  | ToolCallEvent
  | ToolResultEvent
  | ProviderFallbackEvent
  | ContextEvent
  | ContextBreakdownEvent
  | ContextWarningEvent
  | ErrorEvent
  | DoneEvent
  | UsageEvent
  | SynthesisFiredEvent
  | AutoContinueEvent
  | TimeBudgetStatusEvent
  | TurnCompleteEvent
  | VerificationEvent;

export interface TextEvent {
  type: 'text';
  content: string;
}

export interface OutputValidationEvent {
  type: 'output_validation';
  validation: OutputValidationResult;
}

/**
 * Emitted when the loop silently swaps the configured validation profile
 * for a better-fitting one (currently: oracle-prime → coding-answer when
 * productive tools succeeded). Surfaces the magic so users can see why
 * the validation result references a profile they did not configure.
 */
export interface OutputValidationProfilePromotedEvent {
  type: 'output_validation_profile_promoted';
  from: string;
  to: string;
  reason: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  call: ToolCall;
}

export interface ToolResultEvent {
  type: 'tool_result';
  call: ToolCall;
  result: ToolResult;
}

export interface ProviderFallbackEvent {
  type: 'provider_fallback';
  fromBackend: string;
  toBackend: string;
  reason: string;
  cooldownSec?: number;
}

export interface ContextEvent {
  type: 'context';
  strategy: import('../context/compaction').CompactionStrategy;
  tokensFreed: number;
  compactedCount: number;
  autosaved: boolean;
  pressure: number;
  maxTokens: number;
  qualityScore?: number;
  qualityPassed?: boolean;
}

export interface ContextBreakdownEvent {
  type: 'context_breakdown';
  totalTokens: number;
  maxTokens: number;
  pressure: number;
  systemTokens: number;
  historyTokens: number;
  toolResultTokens: number;
  currentUserTokens: number;
  messageCount: number;
}

export interface ContextWarningEvent {
  type: 'context_warning';
  estimatedTokens: number;
  maxTokens: number;
  message: string;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  recoverable: boolean;
}

export interface DoneEvent {
  type: 'done';
  reason: 'completed' | 'completed_with_validation_failures' | 'completed_with_test_failures' | 'max_turns' | 'max_turns_synthesized' | 'time_budget_synthesized' | 'repetition_synthesized' | 'empty_after_tools_synthesized' | 'aborted' | 'error' | 'unproductive' | 'repeated_tool_failure';
  turns: number;
  /** Extra metadata when the done event follows a synthesis turn (timeout/max-turns). */
  synthesisMetadata?: {
    elapsedMs: number;
    totalToolCalls: number;
    anyProductiveToolSucceeded: boolean;
    selfCertIssues: number;
  };
}

/** Per-LLM-call usage stats. Emitted after every successful model call so
 * the UI can show inline cost / token / latency telemetry without scraping
 * provider-specific log fields.
 *
 * `model` is the resolved model name; `turn` is the 1-based loop turn so the
 * UI can attribute multi-turn usage to the right agent reply. `locality`
 * flags whether the serving backend ran locally ($0 marginal) or in the
 * cloud, so the UI can show an honest cost badge instead of assuming local.
 */
export interface UsageEvent {
  type: 'usage';
  model: string;
  turn: number;
  /** Cost-honesty signal: 'local' ($0 marginal), 'cloud' (billed), or
   * 'unknown' when locality could not be established. Optional so legacy
   * emitters/consumers stay valid. */
  locality?: ModelLocality;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
  /** Milliseconds spent loading the model into memory (0 when cached). */
  loadDurationMs?: number;
  /** Milliseconds spent evaluating the prompt (prefill). */
  promptEvalDurationMs?: number;
  /** Milliseconds spent generating tokens. */
  evalDurationMs?: number;
}

/** Emitted when the bonus synthesis turn fires because the model exhausted
 * its tool-turn budget without producing text. Consumers can track this
 * per-model to spot models that routinely need synthesis and may benefit
 * from a higher maxTurns or a different system prompt strategy. */
export interface SynthesisFiredEvent {
  type: 'synthesis_fired';
  model: string;
  maxTurns: number;
  toolCallsTotal: number;
}

/** Emitted when the loop auto-continues instead of stopping at a partial
 * result. The model produced text with suggestions/questions, and the loop
 * injected a "continue" message to keep going autonomously. */
export interface AutoContinueEvent {
  type: 'auto_continue';
  turn: number;
  continuationCount: number;
  reason: string;
}

/** Emitted at the start of each turn when a wall-clock time budget is
 * configured. Lets the UI render a progress indicator showing how much
 * time the agent has left before synthesis fires. */
export interface TimeBudgetStatusEvent {
  type: 'time_budget_status';
  elapsedMs: number;
  budgetMs: number;
  turn: number;
}

/** Emitted at the end of each turn with the wall-clock duration covering
 * the model call plus all tool executions. Use alongside UsageEvent
 * (model inference only) to see where time is spent. */
export interface TurnCompleteEvent {
  type: 'turn_complete';
  turn: number;
  durationMs: number;
  toolCalls: number;
}

/**
 * Emitted after a coding run that mutated files, when `LoopConfig.verify`
 * is enabled. Contains the result of tsc / eslint / npm test so consumers
 * can surface a "Tests passed ✓" or "Tests failed ✗" card without running
 * validation themselves.
 */
export interface VerificationEvent {
  type: 'verification';
  overall: 'pass' | 'fail' | 'warn' | 'skip';
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'warn' | 'skip';
    detail?: string;
    duration_ms?: number;
  }>;
}
