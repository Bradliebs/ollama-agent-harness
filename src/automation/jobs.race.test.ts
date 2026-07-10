// Race regression for the scenario flagged in the system audit:
// AutomationScheduler's tick fires markAutomationJobRun(jobId) while a
// UI route handler calls createAutomationJob in parallel. Both do a
// read-modify-write on the same .harness/automations/jobs.json. Before
// the file lock, one of the writes would overwrite the other's mutation.

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createAutomationJob,
  markAutomationJobRun,
  listAutomationJobs,
  deleteAutomationJob,
  updateAutomationJob,
} from './jobs';
import { _resetFileLocksForTest } from '../persistence/atomicFile';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'jobs-race-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('automation/jobs race regression', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); _resetFileLocksForTest(); });
  afterEach(async () => { await cleanup(dir); });

  it('parallel createAutomationJob calls preserve every job', async () => {
    // Without the lock these read-modify-write sequences interleave and
    // some appends are lost. With the lock every job survives.
    const N = 8;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createAutomationJob(dir, { name: `job-${i}`, prompt: `do thing ${i}`, schedule: '5m' }),
      ),
    );
    const persisted = await listAutomationJobs(dir);
    expect(persisted).toHaveLength(N);
    const createdIds = new Set(created.map((j) => j.id));
    const persistedIds = new Set(persisted.map((j) => j.id));
    expect(persistedIds).toEqual(createdIds);
  });

  it('parallel markAutomationJobRun + createAutomationJob do not lose mutations', async () => {
    // This is the exact scenario the audit flagged: scheduler updates
    // an existing job's lastRunAt while the UI is creating a new one.
    const existing = await createAutomationJob(dir, { name: 'tick-target', prompt: 'p', schedule: '5m' });
    const [marked] = await Promise.all([
      markAutomationJobRun(dir, existing.id, { success: true }),
      createAutomationJob(dir, { name: 'fresh', prompt: 'q', schedule: '10m' }),
      createAutomationJob(dir, { name: 'fresh2', prompt: 'r', schedule: '15m' }),
    ]);
    const persisted = await listAutomationJobs(dir);
    expect(persisted).toHaveLength(3);
    const tickTarget = persisted.find((j) => j.id === existing.id);
    expect(tickTarget).toBeDefined();
    expect(tickTarget!.lastRunAt).toBeDefined();
    expect(tickTarget!.lastRunAt).toBe(marked.lastRunAt);
    // The two new jobs are both present.
    expect(persisted.filter((j) => j.name.startsWith('fresh'))).toHaveLength(2);
  });

  it('parallel delete + update + mark on overlapping ids settles deterministically', async () => {
    const j1 = await createAutomationJob(dir, { name: 'a', prompt: 'p', schedule: '5m' });
    const j2 = await createAutomationJob(dir, { name: 'b', prompt: 'p', schedule: '5m' });
    const j3 = await createAutomationJob(dir, { name: 'c', prompt: 'p', schedule: '5m' });
    await Promise.all([
      deleteAutomationJob(dir, j1.id),
      updateAutomationJob(dir, j2.id, { name: 'b-renamed' }),
      markAutomationJobRun(dir, j3.id, { success: true }),
    ]);
    const persisted = await listAutomationJobs(dir);
    expect(persisted.map((j) => j.id).sort()).toEqual([j2.id, j3.id].sort());
    expect(persisted.find((j) => j.id === j2.id)?.name).toBe('b-renamed');
    expect(persisted.find((j) => j.id === j3.id)?.lastRunAt).toBeDefined();
  });

  it('atomic write leaves no orphan .tmp.* files on the jobs.json directory', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createAutomationJob(dir, { name: `j${i}`, prompt: 'p', schedule: '5m' }),
      ),
    );
    const jobsDir = path.join(dir, '.harness', 'automations');
    const entries = await fs.readdir(jobsDir);
    expect(entries).toContain('jobs.json');
    const orphans = entries.filter((name) => name.includes('.tmp.'));
    expect(orphans).toEqual([]);
  });
});
