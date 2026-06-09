import type { Message } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import type { IChatClient } from '../core/chatClient';
import { estimateTokenCount } from './assembly';
import { compactToolOutput } from './toolOutputCompaction';

/**
 * Closed set of compaction strategies the runtime can emit. Anything tracking
 * `strategy` (session events, UI yields, continuity checkpoints) should use
 * `CompactionStrategy` so a typo can't leak through as an opaque string.
 */
export const COMPACTION_STRATEGIES = [
  'budget_reduction',
  'snip',
  'auto_compact',
  'snip_quality_fallback',
] as const;
export type CompactionStrategy = typeof COMPACTION_STRATEGIES[number];

/**
 * Canonical prefixes for the boundary system messages we inject. Kept as
 * exported constants so anything that produces or detects boundaries shares
 * one source of truth (and pre-existing on-disk session data stays
 * parseable: the prefixes match what the older versions wrote).
 */
export const SNIP_BOUNDARY_PREFIX = '[';
export const SNIP_BOUNDARY_SUFFIX = ' earlier messages snipped to save context]';
export const AUTO_COMPACT_BOUNDARY_PREFIX = '[Compacted summary of ';

/**
 * True when `msg` is a boundary marker injected by a previous compaction
 * pass. Used to prevent boundaries from stacking when the runtime compacts
 * an already-compacted message list.
 */
export function isCompactionBoundary(msg: Message): boolean {
  if (msg.role !== 'system' || typeof msg.content !== 'string') return false;
  const content = msg.content;
  if (content.startsWith(AUTO_COMPACT_BOUNDARY_PREFIX)) return true;
  // Snip boundary: `[<digits> earlier messages snipped to save context]`.
  if (content.startsWith(SNIP_BOUNDARY_PREFIX) && content.endsWith(SNIP_BOUNDARY_SUFFIX)) {
    const middle = content.slice(SNIP_BOUNDARY_PREFIX.length, content.length - SNIP_BOUNDARY_SUFFIX.length);
    if (/^\d+$/.test(middle)) return true;
  }
  return false;
}

function stripCompactionBoundaries(messages: Message[]): Message[] {
  return messages.filter((msg) => !isCompactionBoundary(msg));
}

export interface CompactionConfig {
  maxTokens: number;
  budgetPerToolResult: number;
  snipThreshold: number;
  autoCompactThreshold: number;
  minSummaryQuality?: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  maxTokens: 8192,
  budgetPerToolResult: 4000,
  snipThreshold: 0.7,
  autoCompactThreshold: 0.85,
  minSummaryQuality: 0.25,
};

export interface CompactionValidation {
  score: number;
  passed: boolean;
  missingTerms: string[];
}

export interface CompactionResult {
  messages: Message[];
  strategy: CompactionStrategy;
  tokensFreed: number;
  summary?: string;
  compactedCount?: number;
  validation?: CompactionValidation;
}

export function applyBudgetReduction(
  messages: Message[],
  maxCharsPerResult: number,
): CompactionResult {
  let freed = 0;
  const updated = messages.map((msg) => {
    if (msg.role === 'tool' && msg.content && msg.content.length > maxCharsPerResult) {
      const { content, freedChars } = compactToolOutput(msg.content, maxCharsPerResult);
      freed += Math.ceil(freedChars / 4);
      return { ...msg, content };
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

  // Keep system message + the last N messages. Strip any prior boundary
  // markers so repeated compaction doesn't stack them up.
  const cleaned = stripCompactionBoundaries(messages);
  const systemMessages = cleaned.filter((m) => m.role === 'system');
  const nonSystem = cleaned.filter((m) => m.role !== 'system');
  if (nonSystem.length <= keepCount) {
    // After stripping boundaries we're already within budget; emit a
    // zero-freed result so the caller's guard treats this as a no-op.
    return { messages, strategy: 'snip', tokensFreed: 0 };
  }
  const snipped = nonSystem.slice(-keepCount);
  const droppedCount = nonSystem.length - snipped.length;
  const dropped = nonSystem.slice(0, droppedCount);
  const freed = estimateTokenCount(dropped);

  const boundary: Message = {
    role: 'system' as const,
    content: `${SNIP_BOUNDARY_PREFIX}${droppedCount}${SNIP_BOUNDARY_SUFFIX}`,
  };

  return {
    messages: [...systemMessages, boundary, ...snipped],
    strategy: 'snip',
    tokensFreed: freed,
    summary: boundary.content,
    compactedCount: droppedCount,
  };
}

export async function applyAutoCompact(
  messages: Message[],
  client: IChatClient,
  minSummaryQuality = DEFAULT_COMPACTION_CONFIG.minSummaryQuality ?? 0,
): Promise<CompactionResult> {
  // Strip any prior compaction-boundary system messages first so the LLM
  // summarises the real conversation and we don't stack boundaries.
  const cleaned = stripCompactionBoundaries(messages);
  const systemMessages = cleaned.filter((m) => m.role === 'system');
  const conversation = cleaned.filter((m) => m.role !== 'system');

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
    const validation = validateCompactionSummary(toSummarize, result.message.content, minSummaryQuality);
    if (!validation.passed) {
      const fallback = applySnip(messages, Math.ceil(messages.length * 0.5));
      return { ...fallback, strategy: 'snip_quality_fallback', validation };
    }
    const summary: Message = {
      role: 'system' as const,
      content: `${AUTO_COMPACT_BOUNDARY_PREFIX}${toSummarize.length} messages]\n${result.message.content}`,
    };

    return {
      messages: [...systemMessages, summary, ...toKeep],
      strategy: 'auto_compact',
      tokensFreed: freed,
      summary: result.message.content,
      compactedCount: toSummarize.length,
      validation,
    };
  } catch {
    // If summarization fails, fall back to snip
    return applySnip(messages, Math.ceil(messages.length * 0.5));
  }
}

export async function compactIfNeeded(
  messages: Message[],
  config: CompactionConfig,
  client: IChatClient,
): Promise<CompactionResult> {
  // Layer 1: Budget reduction (always runs)
  let result = applyBudgetReduction(messages, config.budgetPerToolResult);
  let current = result.messages;

  // Layer 2: Auto-compact when close to the limit so continuity is preserved.
  if (estimateTokenCount(current) / config.maxTokens > config.autoCompactThreshold) {
    const compactResult = await applyAutoCompact(current, client, config.minSummaryQuality);
    current = compactResult.messages;
    result = {
      messages: current,
      strategy: compactResult.strategy,
      tokensFreed: result.tokensFreed + compactResult.tokensFreed,
      summary: compactResult.summary,
      compactedCount: compactResult.compactedCount,
      validation: compactResult.validation,
    };
  } else if (estimateTokenCount(current) / config.maxTokens > config.snipThreshold) {
    // Layer 3: Snip as a cheaper pressure release before the hard limit.
    const keepCount = Math.max(6, Math.ceil(current.length * 0.5));
    const snipResult = applySnip(current, keepCount);
    current = snipResult.messages;
    result = {
      messages: current,
      strategy: snipResult.strategy,
      tokensFreed: result.tokensFreed + snipResult.tokensFreed,
      summary: snipResult.summary,
      compactedCount: snipResult.compactedCount,
      validation: snipResult.validation,
    };
  }

  return result;
}

export function validateCompactionSummary(
  sourceMessages: Message[],
  summary: string,
  minScore: number,
): CompactionValidation {
  const requiredTerms = extractRequiredTerms(sourceMessages);
  if (requiredTerms.length === 0) {
    return { score: summary.trim().length > 0 ? 1 : 0, passed: summary.trim().length > 0, missingTerms: [] };
  }
  const lowerSummary = summary.toLowerCase();
  const missingTerms = requiredTerms.filter((term) => !lowerSummary.includes(term.toLowerCase()));
  const score = (requiredTerms.length - missingTerms.length) / requiredTerms.length;
  return { score, passed: score >= minScore && summary.trim().length > 0, missingTerms };
}

function extractRequiredTerms(messages: Message[]): string[] {
  const text = messages.map((message) => message.content ?? '').join('\n');
  const matches = text.match(/(?:[A-Z][A-Za-z0-9_-]{2,}|[\w./-]+\.(?:ts|tsx|js|json|md|ps1|py|rs|cs)|#[0-9]+|[A-Z]{2,}-[0-9]+)/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 12);
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
