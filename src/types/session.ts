import type { Message } from 'ollama';
import type { ToolCall, ToolResult } from './tool';

export type SessionEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'compact_boundary'
  | 'system';

export interface SessionEvent {
  id: string;
  timestamp: string;
  type: SessionEventType;
  data: SessionEventData;
}

export type SessionEventData =
  | { kind: 'message'; message: Message }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'tool_result'; call: ToolCall; result: ToolResult }
  | { kind: 'compact_boundary'; summary: string; compactedCount: number }
  | { kind: 'system'; content: string };

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  model: string;
  projectDir: string;
  parentSessionId?: string;
}
