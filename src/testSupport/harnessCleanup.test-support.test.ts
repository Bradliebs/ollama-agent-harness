import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { diffHarnessRuntimeState, restoreHarnessRuntimeState, seedHarnessAutomationJobsForTest, snapshotHarnessRuntimeState } from './harnessCleanup.test-support';

describe('harness runtime state test support', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-runtime-state-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('detects document additions and automation job mutations', async () => {
    await seedHarnessAutomationJobsForTest(projectDir, [{ id: 'existing-job' }]);
    const documentsDir = path.join(projectDir, '.harness', 'documents');
    await fs.mkdir(documentsDir, { recursive: true });
    await fs.writeFile(path.join(documentsDir, 'existing.md'), '# Existing\n', 'utf-8');
    const snapshot = await snapshotHarnessRuntimeState(projectDir);

    await seedHarnessAutomationJobsForTest(projectDir, [{ id: 'new-job' }]);
    await fs.writeFile(path.join(documentsDir, 'left-behind.md'), '# Left Behind\n', 'utf-8');

    await expect(diffHarnessRuntimeState(projectDir, snapshot)).resolves.toEqual({
      automationJobsChanged: true,
      addedDocuments: ['left-behind.md'],
      removedDocuments: [],
    });
  });

  it('restores automation jobs and removes added documents', async () => {
    await seedHarnessAutomationJobsForTest(projectDir, [{ id: 'existing-job' }]);
    const documentsDir = path.join(projectDir, '.harness', 'documents');
    await fs.mkdir(documentsDir, { recursive: true });
    await fs.writeFile(path.join(documentsDir, 'existing.md'), '# Existing\n', 'utf-8');
    const snapshot = await snapshotHarnessRuntimeState(projectDir);

    await seedHarnessAutomationJobsForTest(projectDir, [{ id: 'test-job' }]);
    await fs.writeFile(path.join(documentsDir, 'left-behind.md'), '# Left Behind\n', 'utf-8');

    await restoreHarnessRuntimeState(projectDir, snapshot);

    await expect(diffHarnessRuntimeState(projectDir, snapshot)).resolves.toEqual({
      automationJobsChanged: false,
      addedDocuments: [],
      removedDocuments: [],
    });
  });
});
