import type { ToolCall, ToolResult } from './tool';
import type { CustomOutputValidationProfile, OutputValidationProfile, OutputValidationResult } from '../core/outputValidation';

export interface LoopConfig {
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
  strategy: string;
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
  reason: 'completed' | 'completed_with_validation_failures' | 'completed_with_test_failures' | 'max_turns' | 'max_turns_synthesized' | 'time_budget_synthesized' | 'repetition_synthesized' | 'aborted' | 'error' | 'unproductive' | 'repeated_tool_failure';
  turns: number;
}

/** Per-LLM-call usage stats. Emitted after every successful model call so
 * the UI can show inline cost / token / latency telemetry without scraping
 * provider-specific log fields.
 *
 * `model` is the resolved model name; `turn` is the 1-based loop turn so the
 * UI can attribute multi-turn usage to the right agent reply. Costs are
 * intentionally omitted — Ollama is local; if a hosted backend is added,
 * wire the conversion at emit time using a per-model rate map.
 */
export interface UsageEvent {
  type: 'usage';
  model: string;
  turn: number;
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
