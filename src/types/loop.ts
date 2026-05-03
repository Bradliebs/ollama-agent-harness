import type { ToolCall, ToolResult } from './tool';
import type { CustomOutputValidationProfile, OutputValidationProfile, OutputValidationResult } from '../core/outputValidation';

export interface LoopConfig {
  model: string;
  systemPrompt: string;
  maxTurns: number;
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
}

export type LoopEvent =
  | TextEvent
  | OutputValidationEvent
  | OutputValidationProfilePromotedEvent
  | ToolCallEvent
  | ToolResultEvent
  | ProviderFallbackEvent
  | ContextEvent
  | ContextWarningEvent
  | ErrorEvent
  | DoneEvent
  | UsageEvent;

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
  reason: 'completed' | 'completed_with_validation_failures' | 'max_turns' | 'aborted' | 'error' | 'unproductive' | 'repeated_tool_failure';
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
}
