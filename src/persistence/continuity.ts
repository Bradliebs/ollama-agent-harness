import type { Message } from 'ollama';
import type { ContinuityCheckpoint, ToolCall } from '../types';
import { estimateTokenCount } from '../context/assembly';

export interface CheckpointInput {
  sessionId: string;
  messages: Message[];
  summary: string;
  strategy: string;
  maxTokens: number;
  pendingToolCalls?: ToolCall[];
}

export function createContinuityCheckpoint(input: CheckpointInput): ContinuityCheckpoint {
  const conversation = input.messages.filter((message) => message.role !== 'system');
  const latestUser = [...conversation].reverse().find((message) => message.role === 'user');
  const recentMessages = conversation
    .slice(-6)
    .map((message) => `${message.role}: ${(message.content ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
    .filter((content) => content.trim().length > 0);
  const tokenEstimate = estimateTokenCount(input.messages);

  return {
    sessionId: input.sessionId,
    timestamp: new Date().toISOString(),
    summary: input.summary,
    currentGoal: latestUser?.content?.replace(/\s+/g, ' ').slice(0, 220) ?? 'Continue the current task',
    recentMessages,
    pendingToolCalls: (input.pendingToolCalls ?? []).map((call) => call.name),
    openQuestions: extractOpenQuestions(conversation),
    nextAction: inferNextAction(conversation),
    tokenEstimate,
    contextPressure: Math.min(1, tokenEstimate / input.maxTokens),
    strategy: input.strategy,
  };
}

function extractOpenQuestions(messages: Message[]): string[] {
  return messages
    .flatMap((message) => (message.content ?? '').split(/\n+/))
    .map((line) => line.trim())
    .filter((line) => line.endsWith('?'))
    .slice(-5);
}

function inferNextAction(messages: Message[]): string {
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const content = latestAssistant?.content ?? '';
  const actionLine = content.split(/\n+/).find((line) => /next|todo|remaining|continue|then/i.test(line));
  return actionLine?.replace(/^[-*\d.\s]+/, '').slice(0, 220) || 'Continue from the latest user request using the checkpoint summary.';
}
