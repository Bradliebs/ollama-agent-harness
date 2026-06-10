import * as path from 'path';
import { BUILT_IN_TASKS } from '../eval/benchmarkTasks';
import { validateExperimentManifest } from './manifest';
import { loadExperimentManifest, resolveExperimentPlan } from './resolver';

const MANIFEST_PATH = path.resolve(
  __dirname,
  '../../cookbook/auto-research.holdout-battery.manifest.json',
);

// Guards the held-out benchmark battery: the manifest must resolve cleanly
// against the real built-in task catalog, every selected id must exist, and
// the development set and holdout must be a clean, content-disjoint partition.
// If these break, an experiment "keep" decision can no longer be trusted.
describe('holdout battery manifest', () => {
  it('is a structurally valid experiment manifest', async () => {
    const manifest = await loadExperimentManifest(MANIFEST_PATH);
    const validation = validateExperimentManifest(manifest);
    expect(validation.ok).toBe(true);
  });

  it('selects every task id from the real built-in catalog', async () => {
    const manifest = await loadExperimentManifest(MANIFEST_PATH);
    const catalogIds = new Set(BUILT_IN_TASKS.map((task) => task.id));
    for (const id of manifest.evaluation.taskIds ?? []) {
      expect(catalogIds.has(id)).toBe(true);
    }
  });

  it('resolves into a clean development/holdout partition', async () => {
    const manifest = await loadExperimentManifest(MANIFEST_PATH);
    const plan = await resolveExperimentPlan({
      projectDir: process.cwd(),
      manifest,
      dryRun: true,
    });

    const selected = new Set(plan.selectedTaskIds);
    const holdout = new Set(plan.holdoutTaskIds ?? []);

    // Every selected task must come from the real catalog (no silent drops).
    expect(plan.selectedTaskCount).toBe(manifest.evaluation.taskIds!.length);
    expect(holdout.size).toBe(manifest.evaluation.holdout!.taskIds!.length);

    // Holdout must be a strict, non-empty subset of the selected tasks...
    expect(holdout.size).toBeGreaterThan(0);
    expect(holdout.size).toBeLessThan(selected.size);
    for (const id of holdout) {
      expect(selected.has(id)).toBe(true);
    }

    // ...and the development set (selected minus holdout) must be disjoint from
    // it. A candidate is tuned against the development set only; if any holdout
    // task leaked into it the generalisation check would be circular.
    const development = plan.selectedTaskIds.filter((id) => !holdout.has(id));
    expect(development.length).toBe(selected.size - holdout.size);
    for (const id of development) {
      expect(holdout.has(id)).toBe(false);
    }
  });

  it('reserves a content-disjoint adversarial/calibration holdout', async () => {
    const manifest = await loadExperimentManifest(MANIFEST_PATH);
    const holdoutIds = manifest.evaluation.holdout!.taskIds!;
    const byId = new Map(BUILT_IN_TASKS.map((task) => [task.id, task]));

    // Every reserved holdout task exists and is tagged as a reserved holdout
    // probe — this is the guard against accidentally moving a dev task in.
    for (const id of holdoutIds) {
      const task = byId.get(id);
      expect(task).toBeDefined();
      expect(task!.tags).toContain('holdout');
      expect(task!.tier).toBe('adversarial');
    }
  });
});
