import type { Message } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import { estimateTokenCount } from './assembly';

export interface CompactionConfig {
  maxTokens: number;
  budgetPerToolResult: number;
  snipThreshold: number;
  autoCompactThreshold: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  maxTokens: 8192,
  budgetPerToolResult: 4000,
  snipThreshold: 0.7,
  autoCompactThreshold: 0.85,
};

export interface CompactionResult {
  messages: Message[];
  strategy: string;
  tokensFreed: number;
}

export function applyBudgetReduction(
  messages: Message[],
  maxCharsPerResult: number,
): CompactionResult {
  let freed = 0;
  const updated = messages.map((msg) => {
    if (msg.role === 'tool' && msg.content && msg.content.length > maxCharsPerResult) {
      const original = msg.content.length;
      const truncated = msg.content.slice(0, maxCharsPerResult) + '\n...(truncated)';
      freed += Math.ceil((original - truncated.length) / 4);
      return { ...msg, content: truncated };
    }
    return msg;
  });

  return { messages: updated, strategy: 'budget_reduction', tokensFreed: freed };
}

export function applySnip(
  messages: Message[],
  keepCount: number,
): CompactionResult {
  if (messages.length <= keepCount) {
    return { messages, strategy: 'snip', tokensFreed: 0 };
  }

  // Keep system message + the last N messages
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const snipped = nonSystem.slice(-keepCount);
  const droppedCount = nonSystem.length - snipped.length;
  const dropped = nonSystem.slice(0, droppedCount);
  const freed = estimateTokenCount(dropped);

  const boundary: Message = {
    role: 'system' as const,
    content: `[${droppedCount} earlier messages snipped to save context]`,
  };

  return {
    messages: [...systemMessages, boundary, ...snipped],
    strategy: 'snip',
    tokensFreed: freed,
  };
}

export async function applyAutoCompact(
  messages: Message[],
  client: OllamaClient,
): Promise<CompactionResult> {
  // Separate system messages from conversation
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');

  if (conversation.length < 4) {
    return { messages, strategy: 'auto_compact', tokensFreed: 0 };
  }

  // Keep the last 2 messages, summarize the rest
  const toSummarize = conversation.slice(0, -2);
  const toKeep = conversation.slice(-2);

  const summaryPrompt = buildCompactPrompt(toSummarize);

  try {
    const result = await client.chat([
      { role: 'system', content: 'You are a conversation summarizer. Produce a concise summary of the conversation below, preserving key decisions, tool results, and context needed for continuing the task.' },
      { role: 'user', content: summaryPrompt },
    ]);

    const freed = estimateTokenCount(toSummarize);
    const summary: Message = {
      role: 'system' as const,
      content: `[Compacted summary of ${toSummarize.length} messages]\n${result.message.content}`,
    };

    return {
      messages: [...systemMessages, summary, ...toKeep],
      strategy: 'auto_compact',
      tokensFreed: freed,
    };
  } catch {
    // If summarization fails, fall back to snip
    return applySnip(messages, Math.ceil(messages.length * 0.5));
  }
}

export async function compactIfNeeded(
  messages: Message[],
  config: CompactionConfig,
  client: OllamaClient,
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokenCount(messages);
  const ratio = tokenEstimate / config.maxTokens;

  // Layer 1: Budget reduction (always runs)
  let result = applyBudgetReduction(messages, config.budgetPerToolResult);
  let current = result.messages;

  // Layer 2: Snip (if above snip threshold)
  if (estimateTokenCount(current) / config.maxTokens > config.snipThreshold) {
    const keepCount = Math.max(6, Math.ceil(current.length * 0.5));
    const snipResult = applySnip(current, keepCount);
    current = snipResult.messages;
    result = { messages: current, strategy: 'snip', tokensFreed: result.tokensFreed + snipResult.tokensFreed };
  }

  // Layer 3: Auto-compact (if still above auto-compact threshold)
  if (estimateTokenCount(current) / config.maxTokens > config.autoCompactThreshold) {
    const compactResult = await applyAutoCompact(current, client);
    current = compactResult.messages;
    result = { messages: current, strategy: 'auto_compact', tokensFreed: result.tokensFreed + compactResult.tokensFreed };
  }

  return result;
}

function buildCompactPrompt(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = m.content?.slice(0, 2000) ?? '';
      return `[${role}]: ${content}`;
    })
    .join('\n\n');
}
