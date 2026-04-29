import type { ToolCall, ToolResult } from './tool';
import type { CustomOutputValidationProfile, OutputValidationProfile, OutputValidationResult } from '../core/outputValidation';

export interface LoopConfig {
  model: string;
  systemPrompt: string;
  maxTurns: number;
  abortSignal?: AbortSignal;
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
  | ToolCallEvent
  | ToolResultEvent
  | ContextEvent
  | ErrorEvent
  | DoneEvent;

export interface TextEvent {
  type: 'text';
  content: string;
}

export interface OutputValidationEvent {
  type: 'output_validation';
  validation: OutputValidationResult;
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

export interface ErrorEvent {
  type: 'error';
  message: string;
  recoverable: boolean;
}

export interface DoneEvent {
  type: 'done';
  reason: 'completed' | 'max_turns' | 'aborted' | 'error';
  turns: number;
}
