import type { Message } from 'ollama';
import type { ToolCall, ToolResult } from './tool';

export type SessionEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'compact_boundary'
  | 'continuity_checkpoint'
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
  | { kind: 'continuity_checkpoint'; checkpoint: ContinuityCheckpoint }
  | { kind: 'system'; content: string };

export interface ContinuityCheckpoint {
  sessionId: string;
  timestamp: string;
  summary: string;
  currentGoal: string;
  recentMessages: string[];
  pendingToolCalls: string[];
  openQuestions: string[];
  nextAction: string;
  tokenEstimate: number;
  contextPressure: number;
  strategy: string;
}

export type SessionStatus = 'running' | 'completed' | 'max_turns' | 'aborted' | 'error';

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt?: string;
  model: string;
  projectDir: string;
  parentSessionId?: string;
  status?: SessionStatus;
  title?: string;
  checkpointCount?: number;
  lastCheckpointAt?: string;
  lastError?: string;
  agentName?: string;
  agentAvatar?: string;
}
