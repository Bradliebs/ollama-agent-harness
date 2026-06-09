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
