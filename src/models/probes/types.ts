import type { Tool } from 'ollama';
import type { IChatClient } from '../../core/chatClient';

export interface ProbeTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProbeResult {
  id: string;
  score: number;
  samples: number;
  details: Record<string, unknown>;
  tokens: ProbeTokenUsage;
  durationMs: number;
  costUsd: number | null;
}

export interface ProbeRunOptions {
  signal?: AbortSignal;
  samples?: number;
  tokenBudget?: number;
  maxContextTokens?: number;
  detectedContextTokens?: number | null;
}

export interface Probe {
  id: string;
  defaultSamples: number;
  defaultTokenBudget: number;
  run(client: IChatClient, opts?: ProbeRunOptions): Promise<ProbeResult>;
}

export function emptyTokens(): ProbeTokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addTokens(total: ProbeTokenUsage, usage: { promptTokens?: number; completionTokens?: number }): void {
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  total.promptTokens += prompt;
  total.completionTokens += completion;
  total.totalTokens += prompt + completion;
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function makeResult(
  id: string,
  score: number,
  samples: number,
  details: Record<string, unknown>,
  tokens: ProbeTokenUsage,
  started: number,
): ProbeResult {
  return {
    id,
    score: clampScore(score),
    samples,
    details,
    tokens,
    durationMs: Math.round(performance.now() - started),
    costUsd: null,
  };
}

export function sampleLimit(opts: ProbeRunOptions | undefined, fallback: number): number {
  return Math.max(1, Math.floor(opts?.samples ?? fallback));
}

export function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function tokenBudgetExceeded(tokens: ProbeTokenUsage, opts?: ProbeRunOptions): boolean {
  return Boolean(opts?.tokenBudget && tokens.totalTokens >= opts.tokenBudget);
}

export function functionTool(name: string, description: string, parameters: Record<string, unknown>): Tool {
  return { type: 'function', function: { name, description, parameters } } as Tool;
}

export function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

export function extractArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}
