import * as fs from 'fs/promises';
import * as path from 'path';

export interface ModelSynthesisRecord {
  fired: number;
  total: number;
  lastFired?: string;
  /** Exponential moving average of wall-clock milliseconds per turn.
   * Updated after each session to drive adaptive time budgets. */
  avgTurnMs?: number;
  /** Total model-requested tool calls observed across sessions. */
  toolCalls?: number;
  /** Successful tool dispatches observed across sessions. */
  toolSuccesses?: number;
  /** Sessions where at least one tool was requested. */
  toolSessions?: number;
  /** Sessions that ended with visible assistant text. */
  finalTextResponses?: number;
  /** Sessions that ended without visible assistant text. */
  emptyTextResponses?: number;
  /** Tool calls recovered from inline JSON fallback parsing, when known. */
  parserLiftedToolCalls?: number;
}

export type SynthesisStatsMap = Record<string, ModelSynthesisRecord>;

const STATS_FILE = 'synthesis-stats.json';

function statsPath(projectDir: string): string {
  return path.join(projectDir, '.harness', STATS_FILE);
}

export async function loadSynthesisStats(projectDir: string): Promise<SynthesisStatsMap> {
  try {
    const raw = await fs.readFile(statsPath(projectDir), 'utf-8');
    return JSON.parse(raw) as SynthesisStatsMap;
  } catch {
    return {};
  }
}

export async function recordSynthesisFired(projectDir: string, model: string): Promise<void> {
  const stats = await loadSynthesisStats(projectDir);
  const record = stats[model] ?? { fired: 0, total: 0 };
  record.fired++;
  record.lastFired = new Date().toISOString();
  stats[model] = record;
  await fs.mkdir(path.dirname(statsPath(projectDir)), { recursive: true });
  await fs.writeFile(statsPath(projectDir), JSON.stringify(stats, null, 2), 'utf-8');
}

export async function recordSessionCompleted(projectDir: string, model: string): Promise<void> {
  const stats = await loadSynthesisStats(projectDir);
  const record = stats[model] ?? { fired: 0, total: 0 };
  record.total++;
  stats[model] = record;
  await fs.mkdir(path.dirname(statsPath(projectDir)), { recursive: true });
  await fs.writeFile(statsPath(projectDir), JSON.stringify(stats, null, 2), 'utf-8');
}

export async function clearSynthesisStats(projectDir: string, model?: string): Promise<void> {
  if (!model) {
    await fs.rm(statsPath(projectDir), { force: true });
    return;
  }
  const stats = await loadSynthesisStats(projectDir);
  delete stats[model];
  if (Object.keys(stats).length === 0) {
    await fs.rm(statsPath(projectDir), { force: true });
  } else {
    await fs.writeFile(statsPath(projectDir), JSON.stringify(stats, null, 2), 'utf-8');
  }
}

/**
 * Compute an adaptive maxTurns for a model based on its synthesis history.
 * If a model triggers synthesis more than 40% of the time, it gets extra
 * turns (up to a cap). Models with no history use the default.
 */
export function adaptiveMaxTurns(stats: SynthesisStatsMap, model: string, defaultMax: number): number {
  const record = stats[model];
  if (!record || record.total < 5) return defaultMax;
  const ratio = record.fired / record.total;
  if (ratio > 0.4) return Math.min(defaultMax + 10, 40);
  return defaultMax;
}

/**
 * Record the average turn duration for a model session. Uses an
 * exponential moving average (α = 0.3) so recent sessions have more
 * weight than old ones, and a single outlier doesn't dominate.
 */
export async function recordAvgTurnDuration(projectDir: string, model: string, avgTurnMs: number): Promise<void> {
  if (!Number.isFinite(avgTurnMs) || avgTurnMs <= 0) return;
  const stats = await loadSynthesisStats(projectDir);
  const record = stats[model] ?? { fired: 0, total: 0 };
  const alpha = 0.3;
  record.avgTurnMs = record.avgTurnMs
    ? Math.round(record.avgTurnMs * (1 - alpha) + avgTurnMs * alpha)
    : Math.round(avgTurnMs);
  stats[model] = record;
  await fs.mkdir(path.dirname(statsPath(projectDir)), { recursive: true });
  await fs.writeFile(statsPath(projectDir), JSON.stringify(stats, null, 2), 'utf-8');
}

export interface ToolUseStatsInput {
  toolCalls: number;
  toolSuccesses: number;
  finalTextResponse: boolean;
  parserLiftedToolCalls?: number;
}

export async function recordToolUseStats(projectDir: string, model: string, input: ToolUseStatsInput): Promise<void> {
  const stats = await loadSynthesisStats(projectDir);
  const record = stats[model] ?? { fired: 0, total: 0 };
  const toolCalls = Math.max(0, Math.floor(input.toolCalls));
  const toolSuccesses = Math.max(0, Math.min(toolCalls, Math.floor(input.toolSuccesses)));
  record.toolCalls = (record.toolCalls ?? 0) + toolCalls;
  record.toolSuccesses = (record.toolSuccesses ?? 0) + toolSuccesses;
  if (toolCalls > 0) record.toolSessions = (record.toolSessions ?? 0) + 1;
  if (input.finalTextResponse) record.finalTextResponses = (record.finalTextResponses ?? 0) + 1;
  else record.emptyTextResponses = (record.emptyTextResponses ?? 0) + 1;
  if (input.parserLiftedToolCalls && input.parserLiftedToolCalls > 0) {
    record.parserLiftedToolCalls = (record.parserLiftedToolCalls ?? 0) + Math.floor(input.parserLiftedToolCalls);
  }
  stats[model] = record;
  await fs.mkdir(path.dirname(statsPath(projectDir)), { recursive: true });
  await fs.writeFile(statsPath(projectDir), JSON.stringify(stats, null, 2), 'utf-8');
}

/** Default time budgets when no per-model data exists. */
const DEFAULT_LOCAL_BUDGET_MS = 180_000;
const DEFAULT_CLOUD_BUDGET_MS = 600_000;
const MIN_BUDGET_MS = 60_000;
const MAX_BUDGET_MS = 900_000;
const TARGET_TURNS = 10;

/**
 * Compute an adaptive time budget for a model based on its measured
 * average turn duration. Targets ~TARGET_TURNS turns, clamped to
 * [MIN_BUDGET_MS, MAX_BUDGET_MS].
 *
 * Falls back to the provided default when no turn history exists.
 */
export function adaptiveTimeBudget(stats: SynthesisStatsMap, model: string, defaultBudgetMs: number): number {
  const record = stats[model];
  if (!record?.avgTurnMs || record.total < 3) return defaultBudgetMs;
  return Math.max(MIN_BUDGET_MS, Math.min(MAX_BUDGET_MS, record.avgTurnMs * TARGET_TURNS));
}
