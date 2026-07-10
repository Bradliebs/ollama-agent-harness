// Standardised per-run metrics envelope. Written alongside the existing
// benchmark `${run.id}.json` so downstream tooling (leaderboards, calibrators,
// dashboards) has one stable shape to read.
//
// Only the fields the harness can authentically populate today are required.
// Cost (tokens, USD) and signal-panel fields are optional and fill in as
// CostTracker and the verification panel get wired through the benchmark
// loop. Producing the envelope now means downstream readers can be built
// against a stable contract; producing fake numbers would poison them.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { PanelResult } from './panel';

export interface BenchmarkRunMetrics {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  model: string;
  baseUrl: string;
  tiers: string[];
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  tasks: BenchmarkTaskMetrics[];
  /** Aggregate token use across the run. Absent when no token accounting ran. */
  tokensIn?: number;
  tokensOut?: number;
  /** Aggregate USD cost. Absent when no cost accounting ran. */
  costUsd?: number;
  /** Per-signal aggregate across all tasks. Absent when no panel ran. */
  perSignal?: Record<string, { score: number; abstainCount: number; runs: number }>;
  /** Per-axis aggregate across all tasks. Absent when no panel ran. */
  perAxis?: Record<string, { score: number; runs: number }>;
}

export interface BenchmarkTaskMetrics {
  taskId: string;
  tier: string;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  toolCalls: number;
  /** Per-task panel result, when one was computed. */
  panel?: PanelResult;
}

export async function writeMetricsJson(dir: string, metrics: BenchmarkRunMetrics): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'metrics.json');
  await fs.writeFile(file, JSON.stringify(metrics, null, 2), 'utf-8');
  return file;
}

/**
 * Aggregate optional per-task panel results into per-signal and per-axis
 * means. Tasks without a panel are ignored (not zero-counted). Returns
 * `undefined` when no task carried a panel.
 */
export function aggregatePanels(tasks: BenchmarkTaskMetrics[]): {
  perSignal?: BenchmarkRunMetrics['perSignal'];
  perAxis?: BenchmarkRunMetrics['perAxis'];
} {
  const signalAcc: Record<string, { sum: number; abstainCount: number; runs: number }> = {};
  const axisAcc: Record<string, { sum: number; runs: number }> = {};
  let anyPanel = false;
  for (const t of tasks) {
    if (!t.panel) continue;
    anyPanel = true;
    for (const [name, r] of Object.entries(t.panel.perSignal)) {
      const s = (signalAcc[name] ??= { sum: 0, abstainCount: 0, runs: 0 });
      if (r.abstain) s.abstainCount++;
      else { s.sum += r.score; s.runs++; }
    }
    for (const [axis, a] of Object.entries(t.panel.perAxis)) {
      const x = (axisAcc[axis] ??= { sum: 0, runs: 0 });
      x.sum += a.score;
      x.runs++;
    }
  }
  if (!anyPanel) return {};
  const perSignal: NonNullable<BenchmarkRunMetrics['perSignal']> = {};
  for (const [name, s] of Object.entries(signalAcc)) {
    perSignal[name] = { score: s.runs > 0 ? s.sum / s.runs : 0, abstainCount: s.abstainCount, runs: s.runs };
  }
  const perAxis: NonNullable<BenchmarkRunMetrics['perAxis']> = {};
  for (const [axis, x] of Object.entries(axisAcc)) {
    perAxis[axis] = { score: x.runs > 0 ? x.sum / x.runs : 0, runs: x.runs };
  }
  return { perSignal, perAxis };
}
