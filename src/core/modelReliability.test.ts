import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadModelReliability, recordModelOutcome, modelReliabilityScore } from './modelReliability';

describe('modelReliability', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-reliability-'));
    await fs.mkdir(path.join(projectDir, '.harness'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty map when no file exists', async () => {
    expect(await loadModelReliability(projectDir)).toEqual({});
  });

  it('accumulates successes and total per (model, taskType)', async () => {
    await recordModelOutcome(projectDir, 'qwen', 'coding', true);
    await recordModelOutcome(projectDir, 'qwen', 'coding', false);
    await recordModelOutcome(projectDir, 'qwen', 'coding', true);
    const map = await loadModelReliability(projectDir);
    expect(map['qwen::coding']).toMatchObject({ successes: 2, total: 3 });
  });

  it('keeps separate records per task type', async () => {
    await recordModelOutcome(projectDir, 'qwen', 'coding', true);
    await recordModelOutcome(projectDir, 'qwen', 'research', false);
    const map = await loadModelReliability(projectDir);
    expect(map['qwen::coding']).toMatchObject({ successes: 1, total: 1 });
    expect(map['qwen::research']).toMatchObject({ successes: 0, total: 1 });
  });

  it('withholds a score until MIN_SAMPLES (3) observations exist', async () => {
    // total = 2 (< 3) → score is not yet trusted, returns undefined.
    await recordModelOutcome(projectDir, 'qwen', 'coding', true);
    await recordModelOutcome(projectDir, 'qwen', 'coding', false);
    let map = await loadModelReliability(projectDir);
    expect(modelReliabilityScore(map, 'qwen', 'coding')).toBeUndefined();
    // total = 3 (>= 3) → successes 2 / total 3.
    await recordModelOutcome(projectDir, 'qwen', 'coding', true);
    map = await loadModelReliability(projectDir);
    expect(modelReliabilityScore(map, 'qwen', 'coding')).toBeCloseTo(2 / 3);
  });

  it('returns undefined for an unknown model/task', async () => {
    const map = await loadModelReliability(projectDir);
    expect(modelReliabilityScore(map, 'nope', 'coding')).toBeUndefined();
  });

  it('ignores outcomes with empty model or taskType', async () => {
    await recordModelOutcome(projectDir, '', 'coding', true);
    await recordModelOutcome(projectDir, 'qwen', '', true);
    expect(await loadModelReliability(projectDir)).toEqual({});
  });
});
