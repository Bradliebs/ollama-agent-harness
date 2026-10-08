import type { Message } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import type { IChatClient, TokenUsage } from '../core/chatClient';
import { estimateTokenCount } from './assembly';
import { compactToolOutput } from './toolOutputCompaction';
import { resolveLoopHardeningEnabled } from '../core/iterationBudget';

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
 * Bracket markers wrapping the historical summary content under
 * `HARNESS_LOOP_HARDENING=1`. They tell the model — explicitly — that the
 * material between the markers is HISTORICAL CONTEXT and that any
 * unfinished tasks below the BEGIN marker are NOT to be resumed; only the
 * latest user message represents an active request. Without this framing,
 * models routinely re-execute long-finished sub-tasks from the summary
 * and burn turns repeating completed work. Borrowed from Hermes
 * `compaction_directive.py`. Boundary detection still keys on
 * `AUTO_COMPACT_BOUNDARY_PREFIX`, so old session JSONL parses unchanged.
 */
export const HISTORICAL_CONTEXT_BEGIN_MARKER =
  '--- BEGIN HISTORICAL CONTEXT SUMMARY (do NOT resume tasks below; only the latest user message is active) ---';
export const HISTORICAL_CONTEXT_END_MARKER =
  '--- END HISTORICAL CONTEXT SUMMARY ---';

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

function isAutoCompactSummary(msg: Message): boolean {
  return isCompactionBoundary(msg) && String(msg.content).startsWith(AUTO_COMPACT_BOUNDARY_PREFIX);
}

/** The text of the most recent auto-compact summary in `messages`, without its header or markers. */
function previousSummaryText(messages: Message[]): string | null {
  const last = [...messages].reverse().find(isAutoCompactSummary);
  if (!last) return null;
  const body = String(last.content).split('\n').slice(1).join('\n')
    .replace(HISTORICAL_CONTEXT_BEGIN_MARKER, '')
    .replace(HISTORICAL_CONTEXT_END_MARKER, '')
    .trim();
  return body || null;
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
  /** Tokens the summarizer call itself used (auto-compaction only). */
  usage?: TokenUsage;
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

/** Tool-call string arguments longer than this are shortened once the call is old. */
export const MAX_OLD_TOOL_ARG_CHARS = 1500;
const ELIDED_ARG_PREFIX = '[';
const ELIDED_ARG_SUFFIX = ' chars omitted to save context; this call already ran]';

/**
 * Shorten long string arguments in tool calls older than the last
 * `keepRecentCalls` assistant tool-call messages. Recent calls stay intact
 * so the model can still refer to what it just wrote.
 */
export function elideOldToolCallArguments(
  messages: Message[],
  keepRecentCalls = 2,
  maxArgChars = MAX_OLD_TOOL_ARG_CHARS,
): CompactionResult {
  const callIndexes = messages.map((m, i) => (m.role === 'assistant' && m.tool_calls?.length ? i : -1)).filter((i) => i >= 0);
  const old = new Set(callIndexes.slice(0, Math.max(0, callIndexes.length - keepRecentCalls)));
  let freedChars = 0;
  const updated = messages.map((msg, index) => {
    if (!old.has(index) || !msg.tool_calls) return msg;
    let changed = false;
    const toolCalls = msg.tool_calls.map((call) => {
      const args = call.function?.arguments;
      if (!args || typeof args !== 'object') return call;
      let callChanged = false;
      const nextArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > maxArgChars && !value.startsWith(ELIDED_ARG_PREFIX)) {
          const marker = `${ELIDED_ARG_PREFIX}${value.length}${ELIDED_ARG_SUFFIX}`;
          freedChars += value.length - marker.length;
          nextArgs[key] = marker;
          callChanged = true;
        } else {
          nextArgs[key] = value;
        }
      }
      if (!callChanged) return call;
      changed = true;
      return { ...call, function: { ...call.function, arguments: nextArgs } };
    });
    return changed ? { ...msg, tool_calls: toolCalls } : msg;
  });
  return { messages: freedChars > 0 ? updated : messages, strategy: 'budget_reduction', tokensFreed: Math.max(0, Math.ceil(freedChars / 4)) };
}

export function applySnip(
  messages: Message[],
  keepCount: number,
): CompactionResult {
  if (messages.length <= keepCount) {
    return { messages, strategy: 'snip', tokensFreed: 0 };
  }

  // Keep system message + the last N messages. Strip any prior boundary
  // markers so repeated compaction doesn't stack them up, but keep the latest
  // auto-compact summary: it is the only record of what came before it.
  const priorSummary = [...messages].reverse().find(isAutoCompactSummary);
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
    messages: [...systemMessages, ...(priorSummary ? [priorSummary] : []), boundary, ...snipped],
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
  // summarises the real conversation and we don't stack boundaries. The
  // previous summary is folded into the new one instead of being dropped.
  const priorSummary = previousSummaryText(messages);
  const cleaned = stripCompactionBoundaries(messages);
  const systemMessages = cleaned.filter((m) => m.role === 'system');
  const conversation = cleaned.filter((m) => m.role !== 'system');

  if (conversation.length < 4) {
    return { messages, strategy: 'auto_compact', tokensFreed: 0 };
  }

  // Keep the last 2 messages, summarize the rest
  const toSummarize = conversation.slice(0, -2);
  const toKeep = conversation.slice(-2);

  const summaryPrompt = priorSummary
    ? `[PREVIOUS SUMMARY]: ${priorSummary}\n\n${buildCompactPrompt(toSummarize)}`
    : buildCompactPrompt(toSummarize);

  try {
    const result = await client.chat([
      { role: 'system', content: 'You are a conversation summarizer. Produce a concise summary of the conversation below, preserving key decisions, tool results, and context needed for continuing the task.' },
      { role: 'user', content: summaryPrompt },
    ]);

    const freed = estimateTokenCount(toSummarize);
    const usage = result.usage ? { usage: result.usage } : {};
    const validation = validateCompactionSummary(toSummarize, result.message.content, minSummaryQuality);
    if (!validation.passed) {
      const fallback = applySnip(messages, Math.ceil(messages.length * 0.5));
      return { ...fallback, strategy: 'snip_quality_fallback', validation, ...usage };
    }
    const summary: Message = {
      role: 'system' as const,
      content: resolveLoopHardeningEnabled()
        ? `${AUTO_COMPACT_BOUNDARY_PREFIX}${toSummarize.length} messages]\n${HISTORICAL_CONTEXT_BEGIN_MARKER}\n${result.message.content}\n${HISTORICAL_CONTEXT_END_MARKER}`
        : `${AUTO_COMPACT_BOUNDARY_PREFIX}${toSummarize.length} messages]\n${result.message.content}`,
    };

    return {
      messages: [...systemMessages, summary, ...toKeep],
      strategy: 'auto_compact',
      tokensFreed: freed,
      summary: result.message.content,
      compactedCount: toSummarize.length,
      validation,
      ...usage,
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

  // Layer 1b: under pressure, shorten large arguments of older tool calls
  // (e.g. a whole file passed to file_write) before dropping or summarising
  // whole messages: those calls already ran, and their effect is on disk.
  if (estimateTokenCount(current) / config.maxTokens > config.snipThreshold) {
    const elided = elideOldToolCallArguments(current);
    if (elided.tokensFreed > 0) {
      current = elided.messages;
      result = { messages: current, strategy: 'budget_reduction', tokensFreed: result.tokensFreed + elided.tokensFreed };
    }
  }

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
      ...(compactResult.usage ? { usage: compactResult.usage } : {}),
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
