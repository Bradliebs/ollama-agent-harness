// Cost tracking — Gap #5 in the harness reliability audit.
//
// Tracks token usage per turn, estimates cost using configurable rates,
// and enforces budget caps. Integrates with LoopConfig.costTracking.

// ─── Default rates ($/1K tokens) ─────────────────────────────────────
// These are approximate Ollama-local rates (essentially free) plus
// common cloud API rates. Users can override via LoopConfig.costTracking.rates.

export interface TokenRate {
  /** Cost per 1K input tokens (USD). */
  input: number;
  /** Cost per 1K output tokens (USD). */
  output: number;
}

const DEFAULT_RATES: Record<string, TokenRate> = {
  // Local models (free)
  'qwen2.5-coder:14b': { input: 0, output: 0 },
  'qwen2.5-coder:7b': { input: 0, output: 0 },
  'gemma3:12b': { input: 0, output: 0 },
  'gemma3:27b': { input: 0, output: 0 },
  'llama3.3:70b': { input: 0, output: 0 },
  'deepseek-coder-v2:16b': { input: 0, output: 0 },
  'codestral:22b': { input: 0, output: 0 },
  // Cloud APIs
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-haiku-3.5': { input: 0.0008, output: 0.004 },
  'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
};

// ─── Tracker ─────────────────────────────────────────────────────────

export interface TurnCost {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface CostSummary {
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  turns: TurnCost[];
  budgetUsd?: number;
  budgetExceeded: boolean;
  /** Cost per successful task (only meaningful in benchmark context). */
  costPerSuccess?: number;
}

export class CostTracker {
  private turns: TurnCost[] = [];
  private rate: TokenRate;
  private budgetUsd?: number;
  readonly model: string;

  constructor(model: string, options?: { budgetUsd?: number; rates?: Record<string, TokenRate> }) {
    this.model = model;
    this.budgetUsd = options?.budgetUsd;
    const customRates = options?.rates ?? {};
    this.rate = customRates[model] ?? DEFAULT_RATES[model] ?? { input: 0, output: 0 };
  }

  /** Record a turn's token usage. Returns true if budget is exceeded. */
  recordTurn(turn: number, inputTokens: number, outputTokens: number): boolean {
    const cost = (inputTokens / 1000) * this.rate.input + (outputTokens / 1000) * this.rate.output;
    this.turns.push({ turn, inputTokens, outputTokens, estimatedCostUsd: Math.round(cost * 1_000_000) / 1_000_000 });
    if (this.budgetUsd !== undefined && this.totalCost() > this.budgetUsd) {
      return true; // budget exceeded
    }
    return false;
  }

  totalCost(): number {
    return this.turns.reduce((s, t) => s + t.estimatedCostUsd, 0);
  }

  totalInputTokens(): number {
    return this.turns.reduce((s, t) => s + t.inputTokens, 0);
  }

  totalOutputTokens(): number {
    return this.turns.reduce((s, t) => s + t.outputTokens, 0);
  }

  summarize(passedTasks?: number): CostSummary {
    const totalCost = this.totalCost();
    return {
      model: this.model,
      totalInputTokens: this.totalInputTokens(),
      totalOutputTokens: this.totalOutputTokens(),
      totalEstimatedCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
      turns: [...this.turns],
      budgetUsd: this.budgetUsd,
      budgetExceeded: this.budgetUsd !== undefined && totalCost > this.budgetUsd,
      costPerSuccess: passedTasks !== undefined && passedTasks > 0
        ? Math.round((totalCost / passedTasks) * 1_000_000) / 1_000_000
        : undefined,
    };
  }

  /** Get rate for display. */
  getRate(): TokenRate {
    return { ...this.rate };
  }

  /** Register or override a model rate at runtime. */
  static registerRate(model: string, rate: TokenRate): void {
    DEFAULT_RATES[model] = rate;
  }

  /** Get all known rates. */
  static getAllRates(): Record<string, TokenRate> {
    return { ...DEFAULT_RATES };
  }
}
