import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addOverride, checkBudgetState, getEnvCapUsd, readTodaySpend, recordSpend } from './dailyBudget';

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-test-'));
  await fs.mkdir(path.join(dir, '.harness'), { recursive: true });
  return dir;
}

async function rm(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('dailyBudget', () => {
  describe('checkBudgetState', () => {
    it('returns off when configured cap is 0', async () => {
      const dir = await makeTempProject();
      try {
        const state = await checkBudgetState(dir, 0);
        expect(state.status).toBe('off');
        expect(state.effectiveCapUsd).toBe(0);
        expect(state.spentUsd).toBe(0);
      } finally { await rm(dir); }
    });

    it('returns ok when no spend recorded and cap is set', async () => {
      const dir = await makeTempProject();
      try {
        const state = await checkBudgetState(dir, 5);
        expect(state.status).toBe('ok');
        expect(state.effectiveCapUsd).toBe(5);
        expect(state.spentUsd).toBe(0);
        expect(state.fraction).toBe(0);
      } finally { await rm(dir); }
    });

    it('returns warn at 80% of cap', async () => {
      const dir = await makeTempProject();
      try {
        await recordSpend(dir, { modelId: 'gpt-4o', estimatedCostUsd: 4 }, 5);
        const state = await checkBudgetState(dir, 5);
        expect(state.status).toBe('warn');
        expect(state.spentUsd).toBeCloseTo(4, 5);
        expect(state.fraction).toBeCloseTo(0.8, 5);
      } finally { await rm(dir); }
    });

    it('returns block when spend equals or exceeds cap', async () => {
      const dir = await makeTempProject();
      try {
        await recordSpend(dir, { modelId: 'gpt-4o', estimatedCostUsd: 5 }, 5);
        const state = await checkBudgetState(dir, 5);
        expect(state.status).toBe('block');
        expect(state.spentUsd).toBeCloseTo(5, 5);
      } finally { await rm(dir); }
    });

    it('fails closed when spend file is corrupt', async () => {
      const dir = await makeTempProject();
      try {
        await fs.writeFile(path.join(dir, '.harness', 'daily-spend.json'), '{this is not json', 'utf-8');
        const state = await checkBudgetState(dir, 5);
        expect(state.status).toBe('unavailable');
        expect(state.reason).toBeDefined();
      } finally { await rm(dir); }
    });

    it('treats stale UTC date as zero spend', async () => {
      const dir = await makeTempProject();
      try {
        const yesterday = new Date('2025-01-01T12:00:00Z');
        const today = new Date('2025-01-02T12:00:00Z');
        await recordSpend(dir, { modelId: 'gpt-4o', estimatedCostUsd: 4 }, 5, yesterday);
        const state = await checkBudgetState(dir, 5, today);
        expect(state.status).toBe('ok');
        expect(state.spentUsd).toBe(0);
        expect(state.utcDate).toBe('2025-01-02');
      } finally { await rm(dir); }
    });
  });

  describe('recordSpend', () => {
    it('accumulates spend across calls in micro-USD precision', async () => {
      const dir = await makeTempProject();
      try {
        await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 0.1 }, 5);
        await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 0.2 }, 5);
        const record = await readTodaySpend(dir);
        expect(record).not.toBeNull();
        expect(record!.spentUsd).toBeCloseTo(0.3, 5);
        expect(record!.byModel.m).toBeCloseTo(0.3, 5);
      } finally { await rm(dir); }
    });

    it('separates spend by model', async () => {
      const dir = await makeTempProject();
      try {
        await recordSpend(dir, { modelId: 'a', estimatedCostUsd: 0.1 }, 5);
        await recordSpend(dir, { modelId: 'b', estimatedCostUsd: 0.2 }, 5);
        const record = await readTodaySpend(dir);
        expect(record!.byModel).toEqual(expect.objectContaining({ a: 0.1, b: 0.2 }));
      } finally { await rm(dir); }
    });

    it('reports crossedWarn exactly once when crossing 80%', async () => {
      const dir = await makeTempProject();
      try {
        const r1 = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 3 }, 5);
        const r2 = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 1.5 }, 5); // 4.5 -> warn
        const r3 = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 0.1 }, 5); // still warn
        expect(r1.crossedWarn).toBe(false);
        expect(r2.crossedWarn).toBe(true);
        expect(r3.crossedWarn).toBe(false);
      } finally { await rm(dir); }
    });

    it('reports crossedBlock exactly once when crossing cap', async () => {
      const dir = await makeTempProject();
      try {
        const r1 = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 4 }, 5);
        const r2 = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 2 }, 5); // 6 -> block
        const r3 = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 1 }, 5); // already block
        expect(r1.crossedBlock).toBe(false);
        expect(r2.crossedBlock).toBe(true);
        expect(r3.crossedBlock).toBe(false);
      } finally { await rm(dir); }
    });

    it('rolls over at UTC day boundary', async () => {
      const dir = await makeTempProject();
      try {
        const day1 = new Date('2025-01-01T23:59:00Z');
        const day2 = new Date('2025-01-02T00:01:00Z');
        await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 4 }, 5, day1);
        const r = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 1 }, 5, day2);
        expect(r.state.utcDate).toBe('2025-01-02');
        expect(r.state.spentUsd).toBeCloseTo(1, 5);
      } finally { await rm(dir); }
    });

    it('returns unavailable state when spend file is corrupt', async () => {
      const dir = await makeTempProject();
      try {
        await fs.writeFile(path.join(dir, '.harness', 'daily-spend.json'), 'not json', 'utf-8');
        const r = await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 1 }, 5);
        expect(r.state.status).toBe('unavailable');
      } finally { await rm(dir); }
    });
  });

  describe('addOverride', () => {
    it('extends today\'s effective cap', async () => {
      const dir = await makeTempProject();
      try {
        await recordSpend(dir, { modelId: 'm', estimatedCostUsd: 5 }, 5);
        const blocked = await checkBudgetState(dir, 5);
        expect(blocked.status).toBe('block');
        const after = await addOverride(dir, 3, 5);
        expect(after.status).toBe('ok');
        expect(after.effectiveCapUsd).toBe(8);
        expect(after.overrideUsd).toBe(3);
      } finally { await rm(dir); }
    });

    it('rejects non-positive overrides', async () => {
      const dir = await makeTempProject();
      try {
        await expect(addOverride(dir, 0, 5)).rejects.toThrow();
        await expect(addOverride(dir, -1, 5)).rejects.toThrow();
      } finally { await rm(dir); }
    });
  });

  describe('getEnvCapUsd', () => {
    const original = process.env.HARNESS_DAILY_SPEND_USD;
    afterEach(() => {
      if (original === undefined) delete process.env.HARNESS_DAILY_SPEND_USD;
      else process.env.HARNESS_DAILY_SPEND_USD = original;
    });

    it('returns 0 when env var unset', () => {
      delete process.env.HARNESS_DAILY_SPEND_USD;
      expect(getEnvCapUsd()).toBe(0);
    });
    it('returns 0 for non-numeric or non-positive values', () => {
      process.env.HARNESS_DAILY_SPEND_USD = 'abc';
      expect(getEnvCapUsd()).toBe(0);
      process.env.HARNESS_DAILY_SPEND_USD = '0';
      expect(getEnvCapUsd()).toBe(0);
      process.env.HARNESS_DAILY_SPEND_USD = '-5';
      expect(getEnvCapUsd()).toBe(0);
    });
    it('returns the numeric value when set positive', () => {
      process.env.HARNESS_DAILY_SPEND_USD = '12.50';
      expect(getEnvCapUsd()).toBe(12.5);
    });
  });
});
