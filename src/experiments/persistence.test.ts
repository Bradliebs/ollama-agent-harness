import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ResolvedExperimentPlan } from './types';
import { listExperimentEvents, persistExperimentPlan } from './persistence';

describe('experiment persistence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'experiment-events-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists dry-run plans as append-only experiment events', async () => {
    const plan: ResolvedExperimentPlan = {
      dryRun: true,
      selectedTaskCount: 1,
      selectedTaskIds: ['task-a'],
      evaluator: { datasetId: 'fixture', scorerVersion: 'v1', taskIds: ['task-a'], tiers: ['canned'] },
      manifest: {
        id: 'exp-1',
        hypothesis: 'test',
        expectedMechanism: 'test',
        allowedMutationScopes: ['model'],
        rollbackTarget: 'HEAD',
        baseline: { id: 'baseline', label: 'Baseline' },
        candidate: { id: 'candidate', label: 'Candidate' },
        evaluation: { datasetId: 'fixture', scorerVersion: 'v1' },
      },
    };

    await persistExperimentPlan(tmpDir, plan);
    await persistExperimentPlan(tmpDir, plan);
    const events = await listExperimentEvents(tmpDir, 'exp-1');
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.category === 'experiment')).toBe(true);
    expect(events.every((event) => event.type === 'experiment_dry_run')).toBe(true);
  });
});