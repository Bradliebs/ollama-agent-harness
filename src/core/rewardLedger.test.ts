import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendRewardEntry, readRewardEntries, summarizeLearningCurve, summarizeGateTrend } from './rewardLedger';

describe('rewardLedger', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rewards-'));
    await fs.mkdir(path.join(projectDir, '.harness'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns an empty list when no ledger exists', async () => {
    expect(await readRewardEntries(projectDir)).toEqual([]);
  });

  it('appends and reads entries in order', async () => {
    await appendRewardEntry(projectDir, { ts: '2026-01-01T00:00:00.000Z', taskType: 'coding', reward: 0.4, model: 'qwen' });
    await appendRewardEntry(projectDir, { ts: '2026-01-02T00:00:00.000Z', taskType: 'research', reward: 0.6, model: 'qwen' });
    const entries = await readRewardEntries(projectDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ reward: 0.4, taskType: 'coding' });
    expect(entries[1]).toMatchObject({ reward: 0.6, taskType: 'research' });
  });

  it('summarizes improvement as later-minus-earlier (positive = improving)', () => {
    // Numeric trace: rewards [0.2, 0.2, 0.8, 0.8] → firstHalf avg 0.2,
    // secondHalf avg 0.8, improvement = 0.8 - 0.2 = +0.6.
    const entries = [
      { ts: '2026-01-01T00:00:00.000Z', reward: 0.2, model: 'm' },
      { ts: '2026-01-01T01:00:00.000Z', reward: 0.2, model: 'm' },
      { ts: '2026-01-02T00:00:00.000Z', reward: 0.8, model: 'm' },
      { ts: '2026-01-02T01:00:00.000Z', reward: 0.8, model: 'm' },
    ];
    const summary = summarizeLearningCurve(entries);
    expect(summary.totalEpisodes).toBe(4);
    expect(summary.overallAvgReward).toBeCloseTo(0.5);
    expect(summary.firstHalfAvgReward).toBeCloseTo(0.2);
    expect(summary.secondHalfAvgReward).toBeCloseTo(0.8);
    expect(summary.improvement).toBeCloseTo(0.6);
  });

  it('reports a negative improvement when rewards decline', () => {
    // rewards [0.9, 0.9, 0.1, 0.1] → improvement = 0.1 - 0.9 = -0.8.
    const entries = [
      { ts: '2026-01-01T00:00:00.000Z', reward: 0.9, model: 'm' },
      { ts: '2026-01-01T01:00:00.000Z', reward: 0.9, model: 'm' },
      { ts: '2026-01-02T00:00:00.000Z', reward: 0.1, model: 'm' },
      { ts: '2026-01-02T01:00:00.000Z', reward: 0.1, model: 'm' },
    ];
    expect(summarizeLearningCurve(entries).improvement).toBeCloseTo(-0.8);
  });

  it('buckets entries by UTC day', () => {
    const entries = [
      { ts: '2026-03-01T08:00:00.000Z', reward: 0.4, model: 'm' },
      { ts: '2026-03-01T20:00:00.000Z', reward: 0.6, model: 'm' },
      { ts: '2026-03-02T09:00:00.000Z', reward: 1.0, model: 'm' },
    ];
    const byDay = summarizeLearningCurve(entries).byDay;
    expect(byDay).toEqual([
      { bucket: '2026-03-01', count: 2, avgReward: 0.5 },
      { bucket: '2026-03-02', count: 1, avgReward: 1.0 },
    ]);
  });

  it('returns zeroed summary for an empty ledger', () => {
    const summary = summarizeLearningCurve([]);
    expect(summary).toMatchObject({ totalEpisodes: 0, overallAvgReward: 0, improvement: 0, byDay: [] });
  });
});

describe('summarizeGateTrend', () => {
  it('ignores entries where the gate did not run', () => {
    const summary = summarizeGateTrend([
      { ts: '2026-03-01T00:00:00.000Z', reward: 0.5, model: 'm' },
      { ts: '2026-03-01T01:00:00.000Z', reward: 0.5, model: 'm', gatePassed: true },
    ]);
    expect(summary.totalGated).toBe(1);
    expect(summary.totalPassed).toBe(1);
    expect(summary.overallPassRate).toBe(1);
  });

  it('reports rising pass rate as positive improvement', () => {
    const summary = summarizeGateTrend([
      { ts: '2026-03-01T00:00:00.000Z', reward: 0.4, model: 'm', gatePassed: false },
      { ts: '2026-03-01T01:00:00.000Z', reward: 0.4, model: 'm', gatePassed: false },
      { ts: '2026-03-02T00:00:00.000Z', reward: 1.0, model: 'm', gatePassed: true },
      { ts: '2026-03-02T01:00:00.000Z', reward: 1.0, model: 'm', gatePassed: true },
    ]);
    expect(summary.firstHalfPassRate).toBe(0);
    expect(summary.secondHalfPassRate).toBe(1);
    expect(summary.improvement).toBe(1);
  });

  it('buckets pass rate by day', () => {
    const summary = summarizeGateTrend([
      { ts: '2026-03-01T08:00:00.000Z', reward: 0, model: 'm', gatePassed: true },
      { ts: '2026-03-01T20:00:00.000Z', reward: 0, model: 'm', gatePassed: false },
      { ts: '2026-03-02T09:00:00.000Z', reward: 0, model: 'm', gatePassed: true },
    ]);
    expect(summary.byDay).toEqual([
      { bucket: '2026-03-01', ran: 2, passed: 1, passRate: 0.5 },
      { bucket: '2026-03-02', ran: 1, passed: 1, passRate: 1 },
    ]);
  });

  it('returns a zeroed summary when nothing was gated', () => {
    expect(summarizeGateTrend([])).toMatchObject({ totalGated: 0, totalPassed: 0, overallPassRate: 0, improvement: 0, byDay: [] });
  });
});
