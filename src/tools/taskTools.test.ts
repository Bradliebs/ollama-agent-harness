import * as fs from 'fs/promises';
import * as path from 'path';
import { TaskManageTool } from './taskTools';
import { getProjectRoot, setProjectRoot } from './pathResolution';

describe('TaskManageTool project root resolution', () => {
  it('persists tasks under setProjectRoot when cwd differs', async () => {
    const originalCwd = process.cwd();
    const previousRoot = getProjectRoot();
    const workspace = path.join(originalCwd, '.harness', `test-task-root-${Date.now()}`);
    const installDir = path.join(originalCwd, '.harness', `test-task-cwd-${Date.now()}`);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });
    setProjectRoot(workspace);
    process.chdir(installDir);
    try {
      const result = await TaskManageTool.execute({ action: 'create', title: 'Workspace task' });
      expect(result.success).toBe(true);

      const raw = await fs.readFile(path.join(workspace, '.harness', 'tasks', 'tasks.json'), 'utf-8');
      expect(raw).toContain('Workspace task');
      await expect(fs.access(path.join(installDir, '.harness', 'tasks', 'tasks.json'))).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      setProjectRoot(previousRoot);
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(installDir, { recursive: true, force: true });
    }
  });
});
