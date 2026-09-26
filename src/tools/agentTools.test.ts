import * as fs from 'fs/promises';
import * as path from 'path';
import { CreateCustomAgentTool } from './agentTools';
import { getProjectRoot, setProjectRoot } from './pathResolution';

describe('CreateCustomAgentTool project root resolution', () => {
  it('writes custom agents under setProjectRoot when cwd differs', async () => {
    const originalCwd = process.cwd();
    const previousRoot = getProjectRoot();
    const workspace = path.join(originalCwd, '.harness', `test-agent-root-${Date.now()}`);
    const installDir = path.join(originalCwd, '.harness', `test-agent-cwd-${Date.now()}`);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });
    setProjectRoot(workspace);
    process.chdir(installDir);
    try {
      const result = await CreateCustomAgentTool.execute({
        id: 'workspace-agent',
        name: 'Workspace Agent',
        description: 'Uses the workspace root.',
        system_prompt: 'You operate in the workspace.',
      });

      expect(result.success).toBe(true);
      await expect(fs.readFile(path.join(workspace, '.harness', 'agents', 'workspace-agent.md'), 'utf-8')).resolves.toContain('Workspace Agent');
      await expect(fs.access(path.join(installDir, '.harness', 'agents', 'workspace-agent.md'))).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      setProjectRoot(previousRoot);
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(installDir, { recursive: true, force: true });
    }
  });
});
