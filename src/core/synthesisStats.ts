import * as fs from 'fs/promises';
import * as path from 'path';

export interface ModelSynthesisRecord {
  fired: number;
  total: number;
  lastFired?: string;
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
