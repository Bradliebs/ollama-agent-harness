import type { ToolCall, ToolResult } from './tool';

export interface LoopConfig {
  model: string;
  systemPrompt: string;
  maxTurns: number;
  abortSignal?: AbortSignal;
}

export type LoopEvent =
  | TextEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | DoneEvent;

export interface TextEvent {
  type: 'text';
  content: string;
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
