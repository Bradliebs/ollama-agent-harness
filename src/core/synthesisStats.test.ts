import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { adaptiveMaxTurns, adaptiveTimeBudget, clearSynthesisStats, loadSynthesisStats, recordAvgTurnDuration, recordSessionCompleted, recordSynthesisFired, recordToolUseStats } from './synthesisStats';

describe('synthesisStats', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-synth-'));
    await fs.mkdir(path.join(projectDir, '.harness'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty stats when no file exists', async () => {
    const stats = await loadSynthesisStats(projectDir);
    expect(stats).toEqual({});
  });

  it('records synthesis fired and session completed', async () => {
    await recordSynthesisFired(projectDir, 'deepseek-v3:671b');
    await recordSessionCompleted(projectDir, 'deepseek-v3:671b');

    const stats = await loadSynthesisStats(projectDir);
    expect(stats['deepseek-v3:671b']).toMatchObject({ fired: 1, total: 1 });
    expect(stats['deepseek-v3:671b'].lastFired).toBeDefined();
  });

  it('accumulates counts across multiple calls', async () => {
    await recordSynthesisFired(projectDir, 'test-model');
    await recordSynthesisFired(projectDir, 'test-model');
    await recordSessionCompleted(projectDir, 'test-model');
    await recordSessionCompleted(projectDir, 'test-model');
    await recordSessionCompleted(projectDir, 'test-model');

    const stats = await loadSynthesisStats(projectDir);
    expect(stats['test-model']).toMatchObject({ fired: 2, total: 3 });
  });

  it('records per-model tool-use and final-response counters', async () => {
    await recordSessionCompleted(projectDir, 'gemma4:e4b');
    await recordToolUseStats(projectDir, 'gemma4:e4b', { toolCalls: 3, toolSuccesses: 2, finalTextResponse: true, parserLiftedToolCalls: 1 });
    await recordToolUseStats(projectDir, 'gemma4:e4b', { toolCalls: 0, toolSuccesses: 0, finalTextResponse: false });

    const stats = await loadSynthesisStats(projectDir);
    expect(stats['gemma4:e4b']).toMatchObject({
      toolCalls: 3,
      toolSuccesses: 2,
      toolSessions: 1,
      finalTextResponses: 1,
      emptyTextResponses: 1,
      parserLiftedToolCalls: 1,
    });
  });

  it('returns default maxTurns when model has no history', () => {
    expect(adaptiveMaxTurns({}, 'unknown-model', 25)).toBe(25);
  });

  it('returns default maxTurns when model has fewer than 5 sessions', () => {
    const stats = { 'test-model': { fired: 3, total: 4 } };
    expect(adaptiveMaxTurns(stats, 'test-model', 25)).toBe(25);
  });

  it('bumps maxTurns when synthesis fires more than 40% of the time', () => {
    const stats = { 'search-heavy': { fired: 5, total: 10 } };
    expect(adaptiveMaxTurns(stats, 'search-heavy', 25)).toBe(35);
  });

  it('caps adaptive maxTurns at 40', () => {
    const stats = { 'search-heavy': { fired: 9, total: 10 } };
    expect(adaptiveMaxTurns(stats, 'search-heavy', 35)).toBe(40);
  });

  it('does not bump when synthesis fires less than 40%', () => {
    const stats = { 'well-behaved': { fired: 1, total: 10 } };
    expect(adaptiveMaxTurns(stats, 'well-behaved', 25)).toBe(25);
  });

  it('clears all stats', async () => {
    await recordSynthesisFired(projectDir, 'model-a');
    await recordSynthesisFired(projectDir, 'model-b');
    await clearSynthesisStats(projectDir);
    expect(await loadSynthesisStats(projectDir)).toEqual({});
  });

  it('clears stats for a single model', async () => {
    await recordSynthesisFired(projectDir, 'model-a');
    await recordSynthesisFired(projectDir, 'model-b');
    await clearSynthesisStats(projectDir, 'model-a');
    const stats = await loadSynthesisStats(projectDir);
    expect(stats['model-a']).toBeUndefined();
    expect(stats['model-b']).toBeDefined();
  });

  it('removes file when clearing the last model', async () => {
    await recordSynthesisFired(projectDir, 'only-model');
    await clearSynthesisStats(projectDir, 'only-model');
    expect(await loadSynthesisStats(projectDir)).toEqual({});
  });

  describe('adaptive time budget', () => {
    it('returns default budget when model has no history', () => {
      expect(adaptiveTimeBudget({}, 'unknown', 180_000)).toBe(180_000);
    });

    it('returns default budget when model has fewer than 3 sessions', () => {
      const stats = { 'new-model': { fired: 0, total: 2, avgTurnMs: 15_000 } };
      expect(adaptiveTimeBudget(stats, 'new-model', 180_000)).toBe(180_000);
    });

    it('computes budget from avgTurnMs * 10 turns', () => {
      const stats = { 'gemma4': { fired: 0, total: 5, avgTurnMs: 20_000 } };
      // 20_000 * 10 = 200_000
      expect(adaptiveTimeBudget(stats, 'gemma4', 180_000)).toBe(200_000);
    });

    it('clamps to minimum 60s', () => {
      const stats = { 'fast-model': { fired: 0, total: 5, avgTurnMs: 2_000 } };
      // 2_000 * 10 = 20_000 < MIN_BUDGET_MS
      expect(adaptiveTimeBudget(stats, 'fast-model', 180_000)).toBe(60_000);
    });

    it('clamps to maximum 900s', () => {
      const stats = { 'slow-model': { fired: 0, total: 5, avgTurnMs: 120_000 } };
      // 120_000 * 10 = 1_200_000 > MAX_BUDGET_MS
      expect(adaptiveTimeBudget(stats, 'slow-model', 180_000)).toBe(900_000);
    });

    it('records average turn duration with EMA', async () => {
      await recordAvgTurnDuration(projectDir, 'test-model', 10_000);
      let stats = await loadSynthesisStats(projectDir);
      expect(stats['test-model'].avgTurnMs).toBe(10_000);

      await recordAvgTurnDuration(projectDir, 'test-model', 20_000);
      stats = await loadSynthesisStats(projectDir);
      // EMA: 10_000 * 0.7 + 20_000 * 0.3 = 13_000
      expect(stats['test-model'].avgTurnMs).toBe(13_000);
    });
  });
});
