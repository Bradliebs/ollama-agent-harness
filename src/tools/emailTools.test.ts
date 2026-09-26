import * as fs from 'fs/promises';
import * as path from 'path';
import { EmailDraftTool } from './emailTools';
import { getProjectRoot, setProjectRoot } from './pathResolution';

describe('EmailDraftTool project root resolution', () => {
  it('saves drafts under setProjectRoot when cwd differs', async () => {
    const originalCwd = process.cwd();
    const previousRoot = getProjectRoot();
    const workspace = path.join(originalCwd, '.harness', `test-email-root-${Date.now()}`);
    const installDir = path.join(originalCwd, '.harness', `test-email-cwd-${Date.now()}`);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });
    setProjectRoot(workspace);
    process.chdir(installDir);
    try {
      const result = await EmailDraftTool.execute({
        to: 'recipient@example.com',
        subject: 'Workspace Draft',
        body: 'Hello from the workspace.',
      });

      expect(result.success).toBe(true);
      const drafts = await fs.readdir(path.join(workspace, '.harness', 'email', 'drafts'));
      expect(drafts.some((name) => name.includes('Workspace-Draft'))).toBe(true);
      await expect(fs.access(path.join(installDir, '.harness', 'email', 'drafts'))).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      setProjectRoot(previousRoot);
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(installDir, { recursive: true, force: true });
    }
  });
});
