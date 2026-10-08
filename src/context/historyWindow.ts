// Which prior chat messages to resend with a new message.
//
// Two constraints, both about tokens:
//   1. Fit: the history has to fit beside the system prompt and the tool
//      definitions, and stay under the loop's snip threshold. Otherwise the
//      first turn of every request compacts it again (snipping half of it, or
//      paying for a summarizer call).
//   2. Stable prefix: providers cache a request's prefix (OpenAI prompt
//      caching, Ollama's KV-cache reuse). Dropping one oldest message per new
//      message shifts the whole history every request, so nothing is ever
//      reused. Cut points are aligned to fixed blocks of the conversation
//      instead, so the same prefix is resent for several requests in a row.

import type { Message } from 'ollama';
import { estimateTokenCount } from './assembly';
import { DEFAULT_COMPACTION_CONFIG } from './compaction';

export interface HistoryWindowOptions {
  /** The context limit the run compacts against (LoopConfig.context.maxTokens). */
  contextMaxTokens: number;
  systemPromptTokens: number;
  /** Tool definitions sent with every request. */
  toolSchemaTokens: number;
  newMessageTokens: number;
  snipThreshold?: number;
  /** Most prior messages ever resent. */
  maxMessages?: number;
  /** Cut points fall on multiples of this many messages (counted from the start of the conversation). */
  alignment?: number;
}

export interface HistoryWindow {
  messages: Message[];
  /** Messages left out, oldest first. */
  dropped: number;
  budget: number;
}

export const HISTORY_MAX_MESSAGES = 50;
export const HISTORY_ALIGNMENT = 8;

/** Token budget for prior history, mirroring how the query loop budgets compaction. */
export function historyTokenBudget(options: HistoryWindowOptions): number {
  const limit = options.contextMaxTokens;
  // Same transcript limit the loop compacts against (see queryLoop).
  const transcriptLimit = Math.max(1024, Math.floor(limit / 2), limit - options.toolSchemaTokens);
  // Aim a little under the snip threshold so the first turn does not compact.
  const target = Math.floor(transcriptLimit * ((options.snipThreshold ?? DEFAULT_COMPACTION_CONFIG.snipThreshold) - 0.05));
  return Math.max(512, target - options.systemPromptTokens - options.newMessageTokens);
}

/**
 * Choose the oldest message to resend: the earliest block-aligned cut that
 * fits the budget and the message cap. `history` must be the whole
 * conversation so far (append-only), so cut positions stay put between
 * requests.
 */
export function selectHistoryWindow(history: readonly Message[], options: HistoryWindowOptions): HistoryWindow {
  const budget = historyTokenBudget(options);
  const maxMessages = options.maxMessages ?? HISTORY_MAX_MESSAGES;
  const alignment = Math.max(1, Math.floor(options.alignment ?? HISTORY_ALIGNMENT));
  const n = history.length;
  // suffix[i] = tokens of history[i..n).
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + estimateTokenCount([history[i] as Message]);
  const fits = (start: number): boolean => n - start <= maxMessages && suffix[start] <= budget;
  let start = -1;
  for (let candidate = 0; candidate <= n; candidate += alignment) {
    if (fits(candidate)) { start = candidate; break; }
  }
  if (start === -1) {
    // No aligned cut fits (e.g. the last few messages are very long): keep as
    // much as fits.
    start = n;
    for (let candidate = 0; candidate <= n; candidate += 1) {
      if (fits(candidate)) { start = candidate; break; }
    }
  }
  return { messages: history.slice(start), dropped: start, budget };
}
