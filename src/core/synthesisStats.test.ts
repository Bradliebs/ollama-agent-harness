import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { adaptiveMaxTurns, clearSynthesisStats, loadSynthesisStats, recordSessionCompleted, recordSynthesisFired } from './synthesisStats';

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
});
