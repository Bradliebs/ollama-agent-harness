// BudgetEnforcingChatClient — daily-spend cap as an IChatClient decorator.
//
// Wraps any IChatClient. Pre-call: refuses when today's spend has already
// hit the cap. Post-call: uses the model's rate table (CostTracker) to
// estimate cost from reported TokenUsage and adds it to today's spend.
//
// Streaming: the IChatClient.chatStream contract does not surface usage,
// so the decorator estimates output tokens from the streamed text length
// (chars / 4 × 1.2 — conservative; over-meters by ~10–20%). This is
// documented intentional drift; an under-meter would defeat the cap.
//
// Locality: clients reporting getLocality() === 'local' are not wrapped
// at the factory level, so this decorator only sees cloud calls.

import type { Message, Tool } from 'ollama';
import type { ChatResult, IChatClient, ModelLocality, StreamChunk, TokenUsage } from '../core/chatClient';
import { CostTracker } from '../eval/costTracker';
import { logger } from '../core/logger';
import { recordSwallowed } from '../observability/silentFailureSink';
import { checkBudgetState, reconcileReservedSpend, reserveSpend } from './dailyBudget';
import type { BudgetState } from './dailyBudget';

export class BudgetExceededError extends Error {
  readonly state: BudgetState;
  constructor(state: BudgetState) {
    const reason = state.status === 'unavailable'
      ? `Daily spend file unavailable: ${state.reason ?? 'unknown'}.`
      : `Daily spend cap reached: $${state.spentUsd.toFixed(4)} of $${state.effectiveCapUsd.toFixed(2)} on ${state.utcDate}.`;
    super(`${reason} Cloud LLM calls are blocked until the cap is raised, an override is added, or the UTC day rolls over.`);
    this.name = 'BudgetExceededError';
    this.state = state;
  }
}

export interface BudgetEnforcingClientOptions {
  inner: IChatClient;
  projectDir: string;
  /** Returns the configured base cap in USD. 0 disables enforcement. Re-read every call so settings.json edits take effect immediately. */
  getCapUsd: () => number;
  /** Override token rate lookup. Defaults to CostTracker's static rate table. */
  rateLookup?: (model: string) => { input: number; output: number };
  /** Hook for tests / observability. Called after every recordSpend with the resulting state. */
  onSpendRecorded?: (info: { state: BudgetState; estimatedCostUsd: number; crossedWarn: boolean; crossedBlock: boolean }) => void;
}

/** chars-per-token heuristic for the streaming path. Conservative — biases toward over-counting. */
const STREAM_CHARS_PER_TOKEN = 4;
const STREAM_SAFETY_MULTIPLIER = 1.2;
const CHAT_COMPLETION_RESERVE_TOKENS = 2_000;
const STREAM_COMPLETION_RESERVE_TOKENS = 4_000;

function estimateOutputTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / STREAM_CHARS_PER_TOKEN) * STREAM_SAFETY_MULTIPLIER);
}

function estimateInputTokensFromMessages(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
  }
  return Math.ceil((chars / STREAM_CHARS_PER_TOKEN) * STREAM_SAFETY_MULTIPLIER);
}

function rateFor(model: string, lookup: BudgetEnforcingClientOptions['rateLookup']): { input: number; output: number } {
  if (lookup) return lookup(model);
  const all = CostTracker.getAllRates();
  return all[model] ?? { input: 0, output: 0 };
}

function costFromUsage(model: string, usage: TokenUsage, lookup: BudgetEnforcingClientOptions['rateLookup']): number {
  const rate = rateFor(model, lookup);
  return (usage.promptTokens / 1000) * rate.input + (usage.completionTokens / 1000) * rate.output;
}

function estimatedCost(model: string, promptTokens: number, completionTokens: number, lookup: BudgetEnforcingClientOptions['rateLookup']): number {
  const rate = rateFor(model, lookup);
  return (promptTokens / 1000) * rate.input + (completionTokens / 1000) * rate.output;
}

export class BudgetEnforcingChatClient implements IChatClient {
  constructor(private readonly opts: BudgetEnforcingClientOptions) {}

  /** Pre-call gate. Throws BudgetExceededError when blocked or when spend file is unavailable (fail-closed). */
  private async assertAllowed(): Promise<void> {
    const cap = this.opts.getCapUsd();
    if (!Number.isFinite(cap) || cap <= 0) return; // off
    const state = await checkBudgetState(this.opts.projectDir, cap);
    if (state.status === 'block' || state.status === 'unavailable') {
      throw new BudgetExceededError(state);
    }
  }

  private async reserveForCost(model: string, estimatedCostUsd: number): Promise<number> {
    const cap = this.opts.getCapUsd();
    if (!Number.isFinite(cap) || cap <= 0 || estimatedCostUsd <= 0) return 0;
    const result = await reserveSpend(this.opts.projectDir, { modelId: model, estimatedCostUsd }, cap);
    if (result.state.status === 'unavailable' || !result.reserved) throw new BudgetExceededError(result.state);
    if (result.crossedWarn) {
      logger.warn('Budget', 'Daily spend crossed warn threshold on reservation', {
        spentUsd: result.state.spentUsd,
        capUsd: result.state.effectiveCapUsd,
        fraction: result.state.fraction,
      });
    }
    return result.reservedCostUsd;
  }

  /** Post-call accounting. Best-effort: errors here are logged + swallowed so a metering hiccup never breaks a successful chat. */
  private async accountForCost(model: string, estimatedCostUsd: number, reservedCostUsd: number): Promise<void> {
    if (estimatedCostUsd <= 0 && reservedCostUsd <= 0) return;
    const cap = this.opts.getCapUsd();
    try {
      const result = await reconcileReservedSpend(this.opts.projectDir, { modelId: model, estimatedCostUsd }, reservedCostUsd, cap);
      if (result.crossedWarn) {
        logger.warn('Budget', 'Daily spend crossed warn threshold', {
          spentUsd: result.state.spentUsd,
          capUsd: result.state.effectiveCapUsd,
          fraction: result.state.fraction,
        });
      }
      if (result.crossedBlock) {
        logger.error('Budget', 'Daily spend cap reached — further cloud calls will be blocked', {
          spentUsd: result.state.spentUsd,
          capUsd: result.state.effectiveCapUsd,
          utcDate: result.state.utcDate,
        });
      }
      this.opts.onSpendRecorded?.({ state: result.state, estimatedCostUsd, crossedWarn: result.crossedWarn, crossedBlock: result.crossedBlock });
    } catch (error) {
      recordSwallowed('budget.recordSpend', error);
    }
  }

  async chat(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): Promise<ChatResult> {
    await this.assertAllowed();
    const model = this.opts.inner.getModel();
    const reservedCostUsd = await this.reserveForCost(model, estimatedCost(model, estimateInputTokensFromMessages(messages), CHAT_COMPLETION_RESERVE_TOKENS, this.opts.rateLookup));
    try {
      const result = await this.opts.inner.chat(messages, tools, abortSignal);
      const cost = costFromUsage(model, result.usage, this.opts.rateLookup);
      await this.accountForCost(model, cost, reservedCostUsd);
      return result;
    } catch (error) {
      await this.accountForCost(model, 0, reservedCostUsd);
      throw error;
    }
  }

  async chatOnce(messages: Message[], tools?: Tool[]): Promise<ChatResult> {
    await this.assertAllowed();
    const model = this.opts.inner.getModel();
    const reservedCostUsd = await this.reserveForCost(model, estimatedCost(model, estimateInputTokensFromMessages(messages), CHAT_COMPLETION_RESERVE_TOKENS, this.opts.rateLookup));
    try {
      const result = await this.opts.inner.chatOnce(messages, tools);
      const cost = costFromUsage(model, result.usage, this.opts.rateLookup);
      await this.accountForCost(model, cost, reservedCostUsd);
      return result;
    } catch (error) {
      await this.accountForCost(model, 0, reservedCostUsd);
      throw error;
    }
  }

  async *chatStream(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
    await this.assertAllowed();
    const model = this.opts.inner.getModel();
    const rate = rateFor(model, this.opts.rateLookup);
    const inputTokensEstimate = estimateInputTokensFromMessages(messages);
    const reservedCostUsd = await this.reserveForCost(model, estimatedCost(model, inputTokensEstimate, STREAM_COMPLETION_RESERVE_TOKENS, this.opts.rateLookup));
    let outputBuffer = '';
    try {
      for await (const chunk of this.opts.inner.chatStream(messages, tools, abortSignal)) {
        if (chunk.content) outputBuffer += chunk.content;
        yield chunk;
      }
    } finally {
      const outputTokensEstimate = estimateOutputTokensFromText(outputBuffer);
      const costEstimate = (inputTokensEstimate / 1000) * rate.input + (outputTokensEstimate / 1000) * rate.output;
      await this.accountForCost(model, costEstimate, reservedCostUsd);
    }
  }

  listModels(): Promise<string[]> { return this.opts.inner.listModels(); }
  getContextWindow(): Promise<number | null> { return this.opts.inner.getContextWindow(); }
  healthCheck(): Promise<{ ok: boolean; error?: string }> { return this.opts.inner.healthCheck(); }
  getModel(): string { return this.opts.inner.getModel(); }
  getLocality(): ModelLocality {
    if (typeof this.opts.inner.getLocality === 'function') return this.opts.inner.getLocality();
    return 'cloud';
  }
}
