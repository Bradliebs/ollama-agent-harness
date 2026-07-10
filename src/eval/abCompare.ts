// A/B model comparison runner — Gap #3 in the harness reliability audit.
//
// Runs the same benchmark task set against two models side-by-side and
// produces a head-to-head comparison: pass rate, cost-proxy (turns),
// average duration, failure categories, and per-task diffs.

import { runBenchmark, summarizeByTier } from './benchmark';
import type { BenchmarkRunOptions, BenchmarkRun, BenchmarkTaskResult, BenchmarkTier } from './benchmark';

// ─── Schema ──────────────────────────────────────────────────────────

export interface ComparisonOptions {
  /** First model identifier (e.g. 'qwen2.5-coder:14b'). */
  modelA: string;
  /** Second model identifier (e.g. 'gemma3:12b'). */
  modelB: string;
  /** Shared benchmark options (tiers, filterIds, projectDir, etc). */
  benchmarkOptions?: Omit<BenchmarkRunOptions, 'model'>;
}

export interface TaskDiff {
  taskId: string;
  tier: BenchmarkTier;
  description: string;
  statusA: 'pass' | 'fail' | 'error';
  statusB: 'pass' | 'fail' | 'error';
  durationMsA: number;
  durationMsB: number;
  /** +1 = A won, -1 = B won, 0 = tie */
  winner: 1 | -1 | 0;
  failureCategoryA?: string;
  failureCategoryB?: string;
}

export interface ModelStats {
  model: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  avgDurationMs: number;
  totalToolCalls: number;
  avgToolCalls: number;
  /** Map of failure category → count. */
  failureCounts: Record<string, number>;
  tierSummary: Array<{ tier: string; total: number; passed: number; passRate: string }>;
}

export interface ComparisonResult {
  id: string;
  createdAt: string;
  modelA: ModelStats;
  modelB: ModelStats;
  diffs: TaskDiff[];
  /** Markdown-formatted leaderboard summary. */
  summary: string;
  runA: BenchmarkRun;
  runB: BenchmarkRun;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildStats(run: BenchmarkRun): ModelStats {
  const totalToolCalls = run.results.reduce((s, r) => s + r.toolCalls.length, 0);
  const avgDurationMs = run.results.length === 0 ? 0 : Math.round(run.results.reduce((s, r) => s + r.durationMs, 0) / run.results.length);

  const failureCounts: Record<string, number> = {};
  for (const r of run.results) {
    if (r.failureCategory) {
      failureCounts[r.failureCategory] = (failureCounts[r.failureCategory] ?? 0) + 1;
    }
  }

  return {
    model: run.model,
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    errored: run.errored,
    passRate: run.passRate,
    avgDurationMs,
    totalToolCalls,
    avgToolCalls: run.results.length === 0 ? 0 : Math.round(totalToolCalls / run.results.length * 10) / 10,
    failureCounts,
    tierSummary: summarizeByTier(run),
  };
}

function buildDiffs(runA: BenchmarkRun, runB: BenchmarkRun): TaskDiff[] {
  const mapB = new Map(runB.results.map((r) => [r.taskId, r]));
  const diffs: TaskDiff[] = [];

  for (const a of runA.results) {
    const b = mapB.get(a.taskId);
    if (!b) continue;
    let winner: 1 | -1 | 0 = 0;
    if (a.status === 'pass' && b.status !== 'pass') winner = 1;
    else if (b.status === 'pass' && a.status !== 'pass') winner = -1;
    else if (a.status === 'pass' && b.status === 'pass') {
      // Both pass — faster wins (ignore ties within 10%)
      const ratio = a.durationMs / Math.max(1, b.durationMs);
      if (ratio < 0.9) winner = 1;
      else if (ratio > 1.1) winner = -1;
    }
    diffs.push({
      taskId: a.taskId,
      tier: a.tier,
      description: a.description,
      statusA: a.status,
      statusB: b.status,
      durationMsA: a.durationMs,
      durationMsB: b.durationMs,
      winner,
      failureCategoryA: a.failureCategory,
      failureCategoryB: b.failureCategory,
    });
  }
  return diffs;
}

function buildSummary(statsA: ModelStats, statsB: ModelStats, diffs: TaskDiff[]): string {
  const winsA = diffs.filter((d) => d.winner === 1).length;
  const winsB = diffs.filter((d) => d.winner === -1).length;
  const ties = diffs.filter((d) => d.winner === 0).length;

  const pctA = (statsA.passRate * 100).toFixed(0);
  const pctB = (statsB.passRate * 100).toFixed(0);

  let md = `## A/B Comparison: ${statsA.model} vs ${statsB.model}\n\n`;
  md += `| Metric | ${statsA.model} | ${statsB.model} |\n`;
  md += `|--------|------|------|\n`;
  md += `| Pass rate | ${pctA}% (${statsA.passed}/${statsA.total}) | ${pctB}% (${statsB.passed}/${statsB.total}) |\n`;
  md += `| Avg duration | ${statsA.avgDurationMs}ms | ${statsB.avgDurationMs}ms |\n`;
  md += `| Avg tool calls | ${statsA.avgToolCalls} | ${statsB.avgToolCalls} |\n`;
  md += `| Task wins | ${winsA} | ${winsB} |\n`;
  md += `| Ties | ${ties} | ${ties} |\n\n`;

  // Per-tier breakdown
  md += `### By Tier\n\n`;
  md += `| Tier | ${statsA.model} | ${statsB.model} |\n`;
  md += `|------|------|------|\n`;
  const allTiers = new Set([...statsA.tierSummary.map((t) => t.tier), ...statsB.tierSummary.map((t) => t.tier)]);
  for (const tier of allTiers) {
    const a = statsA.tierSummary.find((t) => t.tier === tier);
    const b = statsB.tierSummary.find((t) => t.tier === tier);
    md += `| ${tier} | ${a ? `${a.passRate} (${a.passed}/${a.total})` : '—'} | ${b ? `${b.passRate} (${b.passed}/${b.total})` : '—'} |\n`;
  }

  // Disagreements
  const disagreements = diffs.filter((d) => d.winner !== 0);
  if (disagreements.length > 0) {
    md += `\n### Task Disagreements\n\n`;
    for (const d of disagreements) {
      const w = d.winner === 1 ? statsA.model : statsB.model;
      md += `- **${d.taskId}**: ${w} won (${d.statusA}/${d.statusB}, ${d.durationMsA}ms/${d.durationMsB}ms)\n`;
    }
  }

  return md;
}

// ─── Runner ──────────────────────────────────────────────────────────

/**
 * Run the same task set against two models and return a structured comparison.
 */
export async function runComparison(options: ComparisonOptions): Promise<ComparisonResult> {
  const baseOpts = options.benchmarkOptions ?? {};

  // Run A then B sequentially (to avoid resource contention on single-GPU hosts)
  const runA = await runBenchmark({ ...baseOpts, model: options.modelA });
  const runB = await runBenchmark({ ...baseOpts, model: options.modelB });

  const statsA = buildStats(runA);
  const statsB = buildStats(runB);
  const diffs = buildDiffs(runA, runB);
  const summary = buildSummary(statsA, statsB, diffs);

  return {
    id: `cmp-${Date.now()}-${runA.id.slice(-6)}`,
    createdAt: new Date().toISOString(),
    modelA: statsA,
    modelB: statsB,
    diffs,
    summary,
    runA,
    runB,
  };
}
