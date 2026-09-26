// Run supervisor — notices when an agent run has stopped making progress and
// enforces per-run budgets.
//
// Existing guards catch specific pathologies (the same failing tool, the same
// call repeated, identical results). The supervisor watches the task state
// instead: did this turn produce anything new — a new source read, a file
// change, a result not seen before, a verifier pass, a completed plan step?
// Consecutive tool turns without any of those count as stalled, and the
// response escalates in stages:
//
//   warn → change strategy → escalate the model (when the host can) →
//   stop and ask the human what's blocking.
//
// Budgets (tokens, USD where a price is known) stop the run into synthesis
// instead of letting it burn on. Pure and deterministic: the query loop feeds
// it observations and acts on the returned decision.

import { createHash } from 'crypto';

export interface SupervisorConfig {
  /** Consecutive tool turns without progress before the first warning. */
  stallTurns: number;
  /** Per-run token ceiling (prompt + completion). 0 disables. */
  maxTokens: number;
  /** Per-run USD ceiling, applied only when the model has a known price. 0 disables. */
  maxUsd: number;
  /** Whether the host can switch to a stronger model mid-run (Phase 8). */
  canEscalate: boolean;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  stallTurns: 4,
  maxTokens: 1_500_000,
  maxUsd: 0,
  canEscalate: false,
};

export interface TurnObservation {
  toolCalls: number;
  newSources: number;
  filesChanged: number;
  /** Successful tool results this turn (name + output), checked for novelty. */
  successfulResults: Array<{ name: string; output: string }>;
  verifierPasses?: number;
  planStepsCompleted?: number;
  /** Short labels of what was attempted this turn, for the human summary. */
  attempts: string[];
}

export type StallStage = 'warn' | 'change_strategy' | 'escalate' | 'ask_human';

export type SupervisorDecision =
  | { kind: 'progress' }
  | { kind: 'stalled'; stalledTurns: number }
  | { kind: 'intervene'; stage: StallStage; stalledTurns: number; message: string; summary: string };

export interface BudgetStatus {
  exceeded: boolean;
  which?: 'tokens' | 'usd';
  used: number;
  limit: number;
}

export type RateLookup = (model: string) => { input: number; output: number } | undefined;

export class RunSupervisor {
  private readonly config: SupervisorConfig;
  private readonly rateLookup: RateLookup;
  private stalled = 0;
  private readonly seenResults = new Set<string>();
  private readonly recentAttempts: string[] = [];
  private stagesFired = new Set<StallStage>();
  private tokens = 0;
  private usd = 0;
  private priced = false;

  constructor(config: Partial<SupervisorConfig> = {}, rateLookup: RateLookup = () => undefined) {
    this.config = { ...DEFAULT_SUPERVISOR_CONFIG, ...config };
    this.rateLookup = rateLookup;
  }

  get stalledTurns(): number {
    return this.stalled;
  }

  get usage(): { tokens: number; usd: number; priced: boolean } {
    return { tokens: this.tokens, usd: this.usd, priced: this.priced };
  }

  recordUsage(model: string, promptTokens: number, completionTokens: number): void {
    const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0;
    const completion = Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : 0;
    this.tokens += prompt + completion;
    const rate = this.rateLookup(model);
    if (rate && (rate.input > 0 || rate.output > 0)) {
      this.priced = true;
      this.usd += (prompt / 1000) * rate.input + (completion / 1000) * rate.output;
    }
  }

  checkBudget(): BudgetStatus {
    if (this.config.maxTokens > 0 && this.tokens > this.config.maxTokens) {
      return { exceeded: true, which: 'tokens', used: this.tokens, limit: this.config.maxTokens };
    }
    if (this.config.maxUsd > 0 && this.priced && this.usd > this.config.maxUsd) {
      return { exceeded: true, which: 'usd', used: Number(this.usd.toFixed(4)), limit: this.config.maxUsd };
    }
    return { exceeded: false, used: this.tokens, limit: this.config.maxTokens };
  }

  /** Feed one completed tool turn; returns what (if anything) to do about it. */
  endTurn(observation: TurnObservation): SupervisorDecision {
    for (const attempt of observation.attempts) {
      this.recentAttempts.push(attempt);
      if (this.recentAttempts.length > 12) this.recentAttempts.shift();
    }
    let newResults = 0;
    for (const result of observation.successfulResults) {
      const fingerprint = createHash('sha1').update(result.name).update('\0').update(result.output).digest('hex');
      if (!this.seenResults.has(fingerprint)) {
        this.seenResults.add(fingerprint);
        newResults += 1;
      }
    }
    const progressed = observation.newSources > 0
      || observation.filesChanged > 0
      || newResults > 0
      || (observation.verifierPasses ?? 0) > 0
      || (observation.planStepsCompleted ?? 0) > 0;
    if (progressed || observation.toolCalls === 0) {
      this.stalled = 0;
      this.stagesFired = new Set();
      return { kind: 'progress' };
    }
    this.stalled += 1;
    const stage = this.stageFor(this.stalled);
    if (!stage || this.stagesFired.has(stage)) return { kind: 'stalled', stalledTurns: this.stalled };
    this.stagesFired.add(stage);
    return { kind: 'intervene', stage, stalledTurns: this.stalled, message: this.messageFor(stage), summary: this.summary() };
  }

  private stageFor(stalled: number): StallStage | null {
    const base = this.config.stallTurns;
    if (stalled >= base + (this.config.canEscalate ? 5 : 4)) return 'ask_human';
    if (this.config.canEscalate && stalled >= base + 4) return 'escalate';
    if (stalled >= base + 2) return 'change_strategy';
    if (stalled >= base) return 'warn';
    return null;
  }

  private summary(): string {
    const attempts = [...new Set(this.recentAttempts)].slice(-6);
    return attempts.length > 0 ? `Recent attempts without new results: ${attempts.join('; ')}` : 'No recent attempts produced new results.';
  }

  private messageFor(stage: StallStage): string {
    const n = this.stalled;
    switch (stage) {
      case 'warn':
        return `⚠️ Progress check: the last ${n} tool steps produced nothing new (no new sources, files, or results). Step back: what exactly is missing to answer the user, and which single action would get it?`;
      case 'change_strategy':
        return `⚠️ Still no progress after ${n} steps. ${this.summary()}. Do not repeat these. Change strategy: use a different tool or source, reformulate the search, or, if you already have enough, write the answer now.`;
      case 'escalate':
        return `⚠️ No progress after ${n} steps; escalating to a stronger model.`;
      case 'ask_human':
        return `You are stuck: ${n} consecutive steps made no progress. ${this.summary()}. Stop using tools. Tell the user plainly what you found so far, what is blocking you, and ask ONE specific question that would let you continue.`;
    }
  }
}

/** Short label for a tool call, used in the stuck summary. */
export function describeAttempt(name: string, input: Record<string, unknown>): string {
  const target = ['url', 'query', 'path', 'command', 'q'].map((key) => input?.[key]).find((value) => typeof value === 'string' && value.trim());
  const text = typeof target === 'string' ? target.replace(/\s+/g, ' ').trim() : '';
  return text ? `${name}(${text.length > 60 ? `${text.slice(0, 57)}...` : text})` : name;
}

/**
 * Resolve supervisor config from the loop config and environment.
 * HARNESS_SUPERVISOR=0 disables it; HARNESS_RUN_MAX_TOKENS / HARNESS_RUN_MAX_USD
 * override the budgets.
 */
export function resolveSupervisorConfig(overrides: Partial<SupervisorConfig> | false | undefined): SupervisorConfig | null {
  if (overrides === false) return null;
  const env = process.env.HARNESS_SUPERVISOR?.toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') return null;
  const envTokens = Number(process.env.HARNESS_RUN_MAX_TOKENS);
  const envUsd = Number(process.env.HARNESS_RUN_MAX_USD);
  return {
    ...DEFAULT_SUPERVISOR_CONFIG,
    ...(Number.isFinite(envTokens) && envTokens >= 0 && process.env.HARNESS_RUN_MAX_TOKENS ? { maxTokens: envTokens } : {}),
    ...(Number.isFinite(envUsd) && envUsd >= 0 && process.env.HARNESS_RUN_MAX_USD ? { maxUsd: envUsd } : {}),
    ...(overrides ?? {}),
  };
}
