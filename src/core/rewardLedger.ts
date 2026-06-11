import * as fs from 'fs/promises';
import * as path from 'path';
import { withFileLock } from '../persistence/atomicFile';

// Durable reward ledger for the Mycelium reinforcement loop. Each chat turn
// appends one entry capturing the final reward and its components, so the
// learning curve (is the system actually improving?) can be computed offline
// instead of trusting hand-tuned weights blindly. Append-only JSONL, mirroring
// the subagent-routing metric ledger (withFileLock + fs.appendFile).

export interface RewardLedgerEntry {
  /** ISO timestamp of the episode this reward came from. */
  ts: string;
  taskType?: string;
  /** Final blended reward score (0-1). */
  reward: number;
  /** Per-component breakdown that produced the final score. */
  components?: Record<string, number>;
  model: string;
  /**
   * Whether the post-turn build gate passed, when it ran this turn. Undefined
   * when no validation ran (no source files changed, no validation detected).
   * Kept separate from `reward` so "are builds passing more often over time?"
   * can be read as a clean execution signal, not conflated with the blended
   * reinforcement reward.
   */
  gatePassed?: boolean;
}

export interface LearningCurvePoint {
  /** Bucket label (UTC calendar day, YYYY-MM-DD). */
  bucket: string;
  count: number;
  avgReward: number;
}

export interface LearningCurveSummary {
  totalEpisodes: number;
  overallAvgReward: number;
  firstHalfAvgReward: number;
  secondHalfAvgReward: number;
  /** secondHalfAvgReward - firstHalfAvgReward. Positive = improving. */
  improvement: number;
  byDay: LearningCurvePoint[];
}

export interface GateTrendDayPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  bucket: string;
  /** Turns this day where the build gate ran. */
  ran: number;
  /** Of those, how many passed. */
  passed: number;
  /** passed / ran (0-1). */
  passRate: number;
}

export interface GateTrendSummary {
  /** Turns where the build gate actually ran (gatePassed defined). */
  totalGated: number;
  /** Of those, how many passed. */
  totalPassed: number;
  /** totalPassed / totalGated (0-1); 0 when nothing ran. */
  overallPassRate: number;
  firstHalfPassRate: number;
  secondHalfPassRate: number;
  /** secondHalfPassRate - firstHalfPassRate. Positive = builds passing more often over time. */
  improvement: number;
  byDay: GateTrendDayPoint[];
}

function ledgerPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'mycelium', 'rewards.jsonl');
}

export async function appendRewardEntry(projectDir: string, entry: RewardLedgerEntry): Promise<void> {
  const filePath = ledgerPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await withFileLock(filePath, () => fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8'));
}

export async function readRewardEntries(projectDir: string, limit = 1000): Promise<RewardLedgerEntry[]> {
  const filePath = ledgerPath(projectDir);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RewardLedgerEntry)
      .slice(-limit);
  } catch {
    return [];
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Summarize the reward trend. `improvement` is later-minus-earlier so a
 * positive value means rewards rose over time.
 *
 * Numeric trace (directional sanity): rewards [0.2, 0.2, 0.8, 0.8] →
 * firstHalf avg 0.2, secondHalf avg 0.8, improvement = 0.8 - 0.2 = +0.6.
 */
export function summarizeLearningCurve(entries: RewardLedgerEntry[]): LearningCurveSummary {
  const rewards = entries.map((e) => e.reward);
  const mid = Math.floor(rewards.length / 2);
  const firstHalf = rewards.slice(0, mid);
  const secondHalf = rewards.slice(mid);

  const byDayMap = new Map<string, number[]>();
  for (const entry of entries) {
    const bucket = entry.ts.slice(0, 10); // YYYY-MM-DD
    const existing = byDayMap.get(bucket);
    if (existing) existing.push(entry.reward);
    else byDayMap.set(bucket, [entry.reward]);
  }
  const byDay: LearningCurvePoint[] = [...byDayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, values]) => ({ bucket, count: values.length, avgReward: average(values) }));

  const firstHalfAvgReward = average(firstHalf);
  const secondHalfAvgReward = average(secondHalf);
  return {
    totalEpisodes: entries.length,
    overallAvgReward: average(rewards),
    firstHalfAvgReward,
    secondHalfAvgReward,
    improvement: secondHalfAvgReward - firstHalfAvgReward,
    byDay,
  };
}

/**
 * Summarize the build-gate pass-rate trend over time. Considers only entries
 * where the gate ran (`gatePassed` defined), so "did the agent's code start
 * working more often?" is read independently of the blended reward.
 *
 * Numeric trace: gatePassed [false, false, true, true] -> firstHalf rate 0.0,
 * secondHalf rate 1.0, improvement = +1.0.
 */
export function summarizeGateTrend(entries: RewardLedgerEntry[]): GateTrendSummary {
  const gated = entries.filter((e) => typeof e.gatePassed === 'boolean');
  const flags: number[] = gated.map((e) => (e.gatePassed ? 1 : 0));
  const mid = Math.floor(flags.length / 2);
  const firstHalf = flags.slice(0, mid);
  const secondHalf = flags.slice(mid);

  const byDayMap = new Map<string, { ran: number; passed: number }>();
  for (const entry of gated) {
    const bucket = entry.ts.slice(0, 10);
    const acc = byDayMap.get(bucket) ?? { ran: 0, passed: 0 };
    acc.ran += 1;
    if (entry.gatePassed) acc.passed += 1;
    byDayMap.set(bucket, acc);
  }
  const byDay: GateTrendDayPoint[] = [...byDayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, { ran, passed }]) => ({ bucket, ran, passed, passRate: ran > 0 ? passed / ran : 0 }));

  const totalPassed = flags.reduce((sum, v) => sum + v, 0);
  const firstHalfPassRate = average(firstHalf);
  const secondHalfPassRate = average(secondHalf);
  return {
    totalGated: gated.length,
    totalPassed,
    overallPassRate: gated.length > 0 ? totalPassed / gated.length : 0,
    firstHalfPassRate,
    secondHalfPassRate,
    improvement: secondHalfPassRate - firstHalfPassRate,
    byDay,
  };
}
