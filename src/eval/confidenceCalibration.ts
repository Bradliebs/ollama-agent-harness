// Confidence calibration — tracks model prediction confidence vs actual
// correctness, producing Brier-score-style calibration metrics per model.

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────

export interface CalibrationSample {
  id: string;
  model: string;
  /** ISO timestamp */
  timestamp: string;
  /** The model's stated confidence (0.0–1.0) */
  predictedConfidence: number;
  /** Whether the prediction was actually correct */
  actuallyCorrect: boolean;
  /** Optional: what kind of task this was */
  taskType?: string;
}

export interface CalibrationBucket {
  /** Lower bound of the confidence range, e.g. 0.8 */
  rangeStart: number;
  /** Upper bound, e.g. 0.9 */
  rangeEnd: number;
  /** Number of samples in this bucket */
  count: number;
  /** Average predicted confidence in this bucket */
  avgPredicted: number;
  /** Actual accuracy in this bucket (fraction correct) */
  actualAccuracy: number;
  /** Gap: avgPredicted - actualAccuracy */
  gap: number;
}

export interface CalibrationReport {
  model: string;
  totalSamples: number;
  /** Brier score: mean of (predicted - actual)^2. Lower = better. 0.0 = perfect. */
  brierScore: number;
  /** Expected Calibration Error: weighted average |gap| across buckets */
  ece: number;
  /** Overconfidence ratio: fraction of samples where confidence > accuracy */
  overconfidenceRatio: number;
  buckets: CalibrationBucket[];
  /** ISO timestamp of when this report was generated */
  generatedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sanitizeModelName(model: string): string {
  return model.replace(/[^a-zA-Z0-9]/g, '-');
}

function calibrationDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'calibration');
}

function modelFilePath(projectDir: string, model: string): string {
  return path.join(calibrationDir(projectDir), `${sanitizeModelName(model)}.jsonl`);
}

// ─── Core functions ──────────────────────────────────────────────────

const MAX_SAMPLES_PER_MODEL = 10_000;

/** Append a sample to `<projectDir>/.harness/calibration/<model>.jsonl`. */
export async function recordSample(projectDir: string, sample: CalibrationSample): Promise<void> {
  const dir = calibrationDir(projectDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = modelFilePath(projectDir, sample.model);

  // Check current line count to avoid unbounded growth
  try {
    const existing = await fs.promises.readFile(filePath, 'utf-8');
    const lines = existing.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length >= MAX_SAMPLES_PER_MODEL) {
      // Keep the most recent MAX_SAMPLES_PER_MODEL - 1 lines + append new one
      const trimmed = lines.slice(lines.length - (MAX_SAMPLES_PER_MODEL - 1)).join('\n');
      await fs.promises.writeFile(filePath, trimmed + '\n' + JSON.stringify(sample) + '\n', 'utf-8');
      return;
    }
  } catch {
    // File doesn't exist yet — that's fine, just append below
  }

  await fs.promises.appendFile(filePath, JSON.stringify(sample) + '\n', 'utf-8');
}

/** Read all samples for a model. Returns [] if file absent. */
export async function loadSamples(projectDir: string, model: string): Promise<CalibrationSample[]> {
  const filePath = modelFilePath(projectDir, model);
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CalibrationSample);
  } catch {
    return [];
  }
}

/** Pure computation. Default 10 buckets. */
export function computeCalibration(
  samples: CalibrationSample[],
  model: string,
  bucketCount: number = 10,
): CalibrationReport {
  const N = samples.length;

  // Build empty buckets
  const buckets: CalibrationBucket[] = [];
  const step = 1.0 / bucketCount;
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      rangeStart: parseFloat((i * step).toFixed(10)),
      rangeEnd: parseFloat(((i + 1) * step).toFixed(10)),
      count: 0,
      avgPredicted: 0,
      actualAccuracy: 0,
      gap: 0,
    });
  }

  if (N === 0) {
    return {
      model,
      totalSamples: 0,
      brierScore: 0,
      ece: 0,
      overconfidenceRatio: 0,
      buckets,
      generatedAt: new Date().toISOString(),
    };
  }

  // Accumulate per-bucket sums
  const bucketPredSum = new Array<number>(bucketCount).fill(0);
  const bucketCorrectSum = new Array<number>(bucketCount).fill(0);

  for (const s of samples) {
    const idx = Math.min(Math.floor(s.predictedConfidence * bucketCount), bucketCount - 1);
    buckets[idx].count++;
    bucketPredSum[idx] += s.predictedConfidence;
    bucketCorrectSum[idx] += s.actuallyCorrect ? 1 : 0;
  }

  for (let i = 0; i < bucketCount; i++) {
    const c = buckets[i].count;
    if (c > 0) {
      buckets[i].avgPredicted = bucketPredSum[i] / c;
      buckets[i].actualAccuracy = bucketCorrectSum[i] / c;
      buckets[i].gap = buckets[i].avgPredicted - buckets[i].actualAccuracy;
    }
  }

  // Brier score
  let brierSum = 0;
  for (const s of samples) {
    const actual = s.actuallyCorrect ? 1.0 : 0.0;
    brierSum += (s.predictedConfidence - actual) ** 2;
  }
  const brierScore = brierSum / N;

  // ECE
  let ece = 0;
  for (const b of buckets) {
    if (b.count > 0) {
      ece += (b.count / N) * Math.abs(b.gap);
    }
  }

  // Overconfidence ratio
  const highConfSamples = samples.filter((s) => s.predictedConfidence > 0.5);
  let overconfidenceRatio = 0;
  if (highConfSamples.length > 0) {
    const wrongHighConf = highConfSamples.filter((s) => !s.actuallyCorrect).length;
    overconfidenceRatio = wrongHighConf / highConfSamples.length;
  }

  return {
    model,
    totalSamples: N,
    brierScore,
    ece,
    overconfidenceRatio,
    buckets,
    generatedAt: new Date().toISOString(),
  };
}

/** Load samples for a model and compute its calibration report. */
export async function generateReport(projectDir: string, model: string): Promise<CalibrationReport> {
  const samples = await loadSamples(projectDir, model);
  return computeCalibration(samples, model);
}

/** Scan calibration dir and generate a report for every model found. */
export async function generateAllReports(projectDir: string): Promise<CalibrationReport[]> {
  const dir = calibrationDir(projectDir);
  try {
    const files = await fs.promises.readdir(dir);
    const reports: CalibrationReport[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const model = file.replace(/\.jsonl$/, '');
      const filePath = path.join(dir, file);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const samples = content
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as CalibrationSample);
      reports.push(computeCalibration(samples, model));
    }
    return reports;
  } catch {
    return [];
  }
}

/** Render a compact Markdown block for system prompt injection. */
export function renderCalibrationBlock(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(`## Calibration: ${report.model}`);
  lines.push('');
  lines.push(`- **Samples:** ${report.totalSamples}`);
  lines.push(`- **Brier Score:** ${report.brierScore.toFixed(4)}`);
  lines.push(`- **ECE:** ${report.ece.toFixed(4)}`);
  lines.push(`- **Overconfidence Ratio:** ${report.overconfidenceRatio.toFixed(4)}`);
  lines.push('');
  lines.push('| Bucket | Count | Avg Predicted | Actual Accuracy | Gap |');
  lines.push('|--------|-------|---------------|-----------------|-----|');
  for (const b of report.buckets) {
    if (b.count === 0) continue;
    lines.push(
      `| ${b.rangeStart.toFixed(1)}–${b.rangeEnd.toFixed(1)} | ${b.count} | ${b.avgPredicted.toFixed(3)} | ${b.actualAccuracy.toFixed(3)} | ${b.gap >= 0 ? '+' : ''}${b.gap.toFixed(3)} |`,
    );
  }
  return lines.join('\n');
}
