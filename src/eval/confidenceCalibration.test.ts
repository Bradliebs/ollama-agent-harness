import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CalibrationSample,
  CalibrationReport,
  computeCalibration,
  recordSample,
  loadSamples,
  generateReport,
  generateAllReports,
  renderCalibrationBlock,
} from './confidenceCalibration';

// ─── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSample(overrides: Partial<CalibrationSample> = {}): CalibrationSample {
  return {
    id: 'test-1',
    model: 'test-model',
    timestamp: '2025-01-01T00:00:00.000Z',
    predictedConfidence: 0.8,
    actuallyCorrect: true,
    ...overrides,
  };
}

// ─── computeCalibration ──────────────────────────────────────────────

describe('computeCalibration', () => {
  test('returns zeros for 0 samples', () => {
    const report = computeCalibration([], 'empty-model');
    expect(report.model).toBe('empty-model');
    expect(report.totalSamples).toBe(0);
    expect(report.brierScore).toBe(0);
    expect(report.ece).toBe(0);
    expect(report.overconfidenceRatio).toBe(0);
    expect(report.buckets).toHaveLength(10);
    expect(report.buckets.every((b) => b.count === 0)).toBe(true);
  });

  test('perfect calibration yields Brier ~= 0', () => {
    // confidence 1.0, always correct → Brier = 0
    const samples = Array.from({ length: 20 }, (_, i) =>
      makeSample({ id: `s${i}`, predictedConfidence: 1.0, actuallyCorrect: true }),
    );
    const report = computeCalibration(samples, 'perfect');
    expect(report.brierScore).toBeCloseTo(0, 5);
  });

  test('perfectly wrong predictions yield Brier = 1', () => {
    // confidence 1.0, always wrong → Brier = 1
    const samples = Array.from({ length: 10 }, (_, i) =>
      makeSample({ id: `s${i}`, predictedConfidence: 1.0, actuallyCorrect: false }),
    );
    const report = computeCalibration(samples, 'worst');
    expect(report.brierScore).toBeCloseTo(1.0, 5);
  });

  test('overconfident samples detected', () => {
    // All say 0.9 confidence but only 20% correct
    const samples = Array.from({ length: 10 }, (_, i) =>
      makeSample({ id: `s${i}`, predictedConfidence: 0.9, actuallyCorrect: i < 2 }),
    );
    const report = computeCalibration(samples, 'overconf');
    expect(report.overconfidenceRatio).toBeCloseTo(0.8, 5);
    expect(report.brierScore).toBeGreaterThan(0.5);
  });

  test('underconfident samples have negative gap in bucket', () => {
    // All say 0.2 confidence but always correct
    const samples = Array.from({ length: 10 }, (_, i) =>
      makeSample({ id: `s${i}`, predictedConfidence: 0.15, actuallyCorrect: true }),
    );
    const report = computeCalibration(samples, 'underconf');
    const bucket = report.buckets.find((b) => b.count > 0)!;
    expect(bucket.gap).toBeLessThan(0);
  });

  test('Brier score calculation is correct for known values', () => {
    const samples = [
      makeSample({ id: '1', predictedConfidence: 0.8, actuallyCorrect: true }),
      makeSample({ id: '2', predictedConfidence: 0.6, actuallyCorrect: false }),
    ];
    // (0.8-1)^2 = 0.04, (0.6-0)^2 = 0.36 → mean = 0.20
    const report = computeCalibration(samples, 'brier');
    expect(report.brierScore).toBeCloseTo(0.2, 5);
  });

  test('ECE calculation is correct for known values', () => {
    // Two samples both in 0.8–0.9 bucket: avgPred=0.85, accuracy=0.5
    const samples = [
      makeSample({ id: '1', predictedConfidence: 0.8, actuallyCorrect: true }),
      makeSample({ id: '2', predictedConfidence: 0.9, actuallyCorrect: false }),
    ];
    const report = computeCalibration(samples, 'ece');
    // bucket 8 (0.8-0.9): avgPred=0.85, accuracy=0.5, gap=0.35
    // ECE = (2/2)*0.35 = 0.35
    // But sample at 0.9 goes into bucket 9 (0.9-1.0)
    // bucket 8: count=1, avgPred=0.8, accuracy=1.0, gap=-0.2
    // bucket 9: count=1, avgPred=0.9, accuracy=0.0, gap=0.9
    // ECE = (1/2)*0.2 + (1/2)*0.9 = 0.55
    expect(report.ece).toBeCloseTo(0.55, 5);
  });

  test('bucket for confidence 0.0 is the first bucket', () => {
    const samples = [makeSample({ id: '1', predictedConfidence: 0.0, actuallyCorrect: true })];
    const report = computeCalibration(samples, 'edge0');
    expect(report.buckets[0].count).toBe(1);
  });

  test('bucket for confidence 1.0 is the last bucket', () => {
    const samples = [makeSample({ id: '1', predictedConfidence: 1.0, actuallyCorrect: true })];
    const report = computeCalibration(samples, 'edge1');
    expect(report.buckets[9].count).toBe(1);
  });

  test('bucket for confidence 0.5 is the sixth bucket (index 5)', () => {
    const samples = [makeSample({ id: '1', predictedConfidence: 0.5, actuallyCorrect: true })];
    const report = computeCalibration(samples, 'edge5');
    expect(report.buckets[5].count).toBe(1);
  });

  test('custom bucket count', () => {
    const samples = [makeSample({ id: '1', predictedConfidence: 0.75, actuallyCorrect: true })];
    const report = computeCalibration(samples, 'custom', 4);
    expect(report.buckets).toHaveLength(4);
    // 0.75 → bucket index 3 (0.75-1.0)
    expect(report.buckets[3].count).toBe(1);
  });

  test('all correct samples', () => {
    const samples = Array.from({ length: 5 }, (_, i) =>
      makeSample({ id: `s${i}`, predictedConfidence: 0.7, actuallyCorrect: true }),
    );
    const report = computeCalibration(samples, 'allcorrect');
    // Brier = (0.7-1)^2 = 0.09
    expect(report.brierScore).toBeCloseTo(0.09, 5);
    expect(report.overconfidenceRatio).toBe(0);
  });

  test('all incorrect samples', () => {
    const samples = Array.from({ length: 5 }, (_, i) =>
      makeSample({ id: `s${i}`, predictedConfidence: 0.7, actuallyCorrect: false }),
    );
    const report = computeCalibration(samples, 'allwrong');
    // Brier = (0.7-0)^2 = 0.49
    expect(report.brierScore).toBeCloseTo(0.49, 5);
    expect(report.overconfidenceRatio).toBe(1.0);
  });

  test('single sample', () => {
    const report = computeCalibration([makeSample()], 'single');
    expect(report.totalSamples).toBe(1);
    expect(report.brierScore).toBeCloseTo(0.04, 5); // (0.8-1)^2
  });

  test('overconfidence ratio ignores low-confidence samples', () => {
    // Two low-confidence wrong samples shouldn't affect overconfidence ratio
    const samples = [
      makeSample({ id: '1', predictedConfidence: 0.3, actuallyCorrect: false }),
      makeSample({ id: '2', predictedConfidence: 0.4, actuallyCorrect: false }),
      makeSample({ id: '3', predictedConfidence: 0.8, actuallyCorrect: true }),
    ];
    const report = computeCalibration(samples, 'lowconf');
    // Only 1 sample above 0.5 and it's correct → overconfidence = 0
    expect(report.overconfidenceRatio).toBe(0);
  });

  test('generatedAt is a valid ISO timestamp', () => {
    const report = computeCalibration([], 'ts');
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });

  test('5 buckets distributes samples correctly', () => {
    const samples = [
      makeSample({ id: '1', predictedConfidence: 0.1 }),
      makeSample({ id: '2', predictedConfidence: 0.3 }),
      makeSample({ id: '3', predictedConfidence: 0.5 }),
      makeSample({ id: '4', predictedConfidence: 0.7 }),
      makeSample({ id: '5', predictedConfidence: 0.9 }),
    ];
    const report = computeCalibration(samples, 'dist', 5);
    expect(report.buckets[0].count).toBe(1); // 0.0-0.2
    expect(report.buckets[1].count).toBe(1); // 0.2-0.4
    expect(report.buckets[2].count).toBe(1); // 0.4-0.6
    expect(report.buckets[3].count).toBe(1); // 0.6-0.8
    expect(report.buckets[4].count).toBe(1); // 0.8-1.0
  });

  test('mixed calibration ECE sums correctly', () => {
    // Spread samples across buckets to verify weighted sum
    const samples = [
      makeSample({ id: '1', predictedConfidence: 0.15, actuallyCorrect: true }),
      makeSample({ id: '2', predictedConfidence: 0.85, actuallyCorrect: false }),
    ];
    const report = computeCalibration(samples, 'mixece');
    // Bucket 1: avgPred=0.15, acc=1.0, gap=-0.85, weight=1/2
    // Bucket 8: avgPred=0.85, acc=0.0, gap=0.85, weight=1/2
    // ECE = 0.5*0.85 + 0.5*0.85 = 0.85
    expect(report.ece).toBeCloseTo(0.85, 5);
  });
});

// ─── Persistence ─────────────────────────────────────────────────────

describe('recordSample + loadSamples', () => {
  test('round-trip: record then load', async () => {
    const sample = makeSample();
    await recordSample(tmpDir, sample);
    const loaded = await loadSamples(tmpDir, 'test-model');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(sample);
  });

  test('multiple samples are appended', async () => {
    await recordSample(tmpDir, makeSample({ id: 'a' }));
    await recordSample(tmpDir, makeSample({ id: 'b' }));
    const loaded = await loadSamples(tmpDir, 'test-model');
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('a');
    expect(loaded[1].id).toBe('b');
  });

  test('loadSamples returns [] for missing file', async () => {
    const loaded = await loadSamples(tmpDir, 'nonexistent');
    expect(loaded).toEqual([]);
  });

  test('model name is sanitized in file path', async () => {
    const sample = makeSample({ model: 'qwen2.5:7b' });
    await recordSample(tmpDir, sample);
    const filePath = path.join(tmpDir, '.harness', 'calibration', 'qwen2-5-7b.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test('preserves taskType through persistence', async () => {
    const sample = makeSample({ taskType: 'code-review' });
    await recordSample(tmpDir, sample);
    const loaded = await loadSamples(tmpDir, 'test-model');
    expect(loaded[0].taskType).toBe('code-review');
  });
});

// ─── generateReport ──────────────────────────────────────────────────

describe('generateReport', () => {
  test('end-to-end: record samples then generate report', async () => {
    await recordSample(tmpDir, makeSample({ id: '1', predictedConfidence: 0.9, actuallyCorrect: true }));
    await recordSample(tmpDir, makeSample({ id: '2', predictedConfidence: 0.9, actuallyCorrect: false }));
    const report = await generateReport(tmpDir, 'test-model');
    expect(report.totalSamples).toBe(2);
    expect(report.model).toBe('test-model');
    expect(report.brierScore).toBeGreaterThan(0);
  });

  test('returns empty report for model with no data', async () => {
    const report = await generateReport(tmpDir, 'ghost');
    expect(report.totalSamples).toBe(0);
    expect(report.brierScore).toBe(0);
  });
});

// ─── generateAllReports ──────────────────────────────────────────────

describe('generateAllReports', () => {
  test('scans multiple models', async () => {
    await recordSample(tmpDir, makeSample({ model: 'model-a' }));
    await recordSample(tmpDir, makeSample({ model: 'model-b' }));
    const reports = await generateAllReports(tmpDir);
    expect(reports).toHaveLength(2);
    const names = reports.map((r) => r.model).sort();
    expect(names).toEqual(['model-a', 'model-b']);
  });

  test('returns [] when calibration dir does not exist', async () => {
    const reports = await generateAllReports(path.join(tmpDir, 'nope'));
    expect(reports).toEqual([]);
  });
});

// ─── renderCalibrationBlock ──────────────────────────────────────────

describe('renderCalibrationBlock', () => {
  test('output contains model name and metrics', () => {
    const report = computeCalibration(
      [makeSample({ predictedConfidence: 0.8, actuallyCorrect: true })],
      'render-test',
    );
    const md = renderCalibrationBlock(report);
    expect(md).toContain('## Calibration: render-test');
    expect(md).toContain('Brier Score');
    expect(md).toContain('ECE');
    expect(md).toContain('Overconfidence Ratio');
    expect(md).toContain('Samples');
  });

  test('renders table rows only for non-empty buckets', () => {
    const report = computeCalibration(
      [makeSample({ predictedConfidence: 0.85, actuallyCorrect: true })],
      'sparse',
    );
    const md = renderCalibrationBlock(report);
    const tableRows = md.split('\n').filter((l) => l.startsWith('|') && !l.includes('Bucket') && !l.includes('---'));
    expect(tableRows).toHaveLength(1);
  });

  test('empty report renders header but no table rows', () => {
    const report = computeCalibration([], 'empty');
    const md = renderCalibrationBlock(report);
    expect(md).toContain('## Calibration: empty');
    const tableRows = md.split('\n').filter((l) => l.startsWith('|') && !l.includes('Bucket') && !l.includes('---'));
    expect(tableRows).toHaveLength(0);
  });
});
