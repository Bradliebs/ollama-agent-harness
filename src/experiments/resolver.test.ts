import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { BenchmarkTask } from '../eval/benchmark';
import type { ExperimentManifest } from './types';
import { loadExperimentManifest, resolveExperimentPlan } from './resolver';

const tasks: BenchmarkTask[] = [
  { id: 'task-a', tier: 'canned', description: 'a', input: 'a' },
  { id: 'task-b', tier: 'stress', description: 'b', input: 'b' },
];

function manifest(overrides: Partial<ExperimentManifest> = {}): ExperimentManifest {
  return {
    id: 'exp-1',
    hypothesis: 'Model B answers more benchmark tasks correctly.',
    expectedMechanism: 'The candidate model has better instruction following.',
    allowedMutationScopes: ['model'],
    rollbackTarget: 'HEAD',
    baseline: { id: 'baseline', label: 'Baseline', model: 'model-a' },
    candidate: { id: 'candidate', label: 'Candidate', model: 'model-b' },
    evaluation: { datasetId: 'fixture', scorerVersion: 'v1', taskIds: ['task-b'] },
    ...overrides,
  };
}

describe('loadExperimentManifest', () => {
  it('loads a JSON manifest from disk', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'experiment-manifest-'));
    try {
      const file = path.join(tmpDir, 'manifest.json');
      await fs.writeFile(file, JSON.stringify(manifest()), 'utf-8');
      await expect(loadExperimentManifest(file)).resolves.toMatchObject({ id: 'exp-1' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('resolveExperimentPlan', () => {
  it('selects tasks and captures evaluator identity', async () => {
    const plan = await resolveExperimentPlan({ projectDir: process.cwd(), manifest: manifest(), tasks, dryRun: true });
    expect(plan.selectedTaskIds).toEqual(['task-b']);
    expect(plan.evaluator).toEqual({
      datasetId: 'fixture',
      scorerVersion: 'v1',
      taskIds: ['task-b'],
      tiers: ['stress'],
      perTaskTimeoutMs: undefined,
    });
    expect(plan.dryRun).toBe(true);
  });

  it('rejects empty task selections', async () => {
    await expect(resolveExperimentPlan({
      projectDir: process.cwd(),
      manifest: manifest({ evaluation: { datasetId: 'fixture', scorerVersion: 'v1', taskIds: ['missing'] } }),
      tasks,
    })).rejects.toThrow(/selected zero/);
  });

  it('rejects task selections that exceed maxTasks', async () => {
    await expect(resolveExperimentPlan({
      projectDir: process.cwd(),
      manifest: manifest({ evaluation: { datasetId: 'fixture', scorerVersion: 'v1' }, budget: { maxTasks: 1 } }),
      tasks,
    })).rejects.toThrow(/exceeding budget/);
  });

  it('rejects task selections that exceed maxCostUnits', async () => {
    await expect(resolveExperimentPlan({
      projectDir: process.cwd(),
      manifest: manifest({ evaluation: { datasetId: 'fixture', scorerVersion: 'v1' }, budget: { maxCostUnits: 2 } }),
      tasks,
    })).rejects.toThrow(/budget.maxCostUnits/);
  });

  it('resolves an explicit holdout subset against the selected tasks', async () => {
    const plan = await resolveExperimentPlan({
      projectDir: process.cwd(),
      manifest: manifest({ evaluation: { datasetId: 'fixture', scorerVersion: 'v1', holdout: { taskIds: ['task-b'] } } }),
      tasks,
    });
    expect(plan.holdoutTaskIds).toEqual(['task-b']);
  });

  it('rejects an explicit holdout that matches no selected task', async () => {
    await expect(resolveExperimentPlan({
      projectDir: process.cwd(),
      manifest: manifest({ evaluation: { datasetId: 'fixture', scorerVersion: 'v1', taskIds: ['task-b'], holdout: { taskIds: ['task-a'] } } }),
      tasks,
    })).rejects.toThrow(/holdout\.taskIds matched none/);
  });

  it('partitions a deterministic, stable holdout fraction', async () => {
    const manyTasks: BenchmarkTask[] = Array.from({ length: 8 }, (_, index) => ({
      id: `frac-task-${index}`,
      tier: 'canned' as const,
      description: `t${index}`,
      input: `t${index}`,
    }));
    const opts = {
      projectDir: process.cwd(),
      manifest: manifest({ evaluation: { datasetId: 'fixture', scorerVersion: 'v1', holdout: { fraction: 0.5 } } }),
      tasks: manyTasks,
    };
    const first = await resolveExperimentPlan(opts);
    const second = await resolveExperimentPlan(opts);
    expect(first.holdoutTaskIds).toEqual(second.holdoutTaskIds);
    expect(first.holdoutTaskIds!.length).toBeGreaterThan(0);
    expect(first.holdoutTaskIds!.length).toBeLessThan(manyTasks.length);
    for (const id of first.holdoutTaskIds!) {
      expect(first.selectedTaskIds).toContain(id);
    }
  });

  it('leaves holdoutTaskIds undefined when no holdout is configured', async () => {
    const plan = await resolveExperimentPlan({ projectDir: process.cwd(), manifest: manifest(), tasks });
    expect(plan.holdoutTaskIds).toBeUndefined();
  });
});