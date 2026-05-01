import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CuratorPreviewTool, setCuratorToolRuntime } from './curatorTools';
import { DEFAULT_CURATOR_CONFIG } from '../curator/curator';
import { saveSkillUsage, type SkillUsageStore } from '../extensibility/skillUsage';

describe('CuratorPreviewTool', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-tool-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    for (const name of ['fresh', 'stale']) {
      await fs.mkdir(path.join(skillsDir, name), { recursive: true });
      await fs.writeFile(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\ndomain: t\n---\n# ${name}`, 'utf-8');
    }
    const longAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const store: SkillUsageStore = {
      version: 1,
      records: {
        fresh: { name: 'fresh', useCount: 5, viewCount: 5, lastUsedAt: recent, pinned: false, archived: false, firstSeenAt: longAgo, updatedAt: recent },
        stale: { name: 'stale', useCount: 1, viewCount: 3, lastUsedAt: longAgo, pinned: false, archived: false, firstSeenAt: longAgo, updatedAt: longAgo },
      },
    };
    await saveSkillUsage(projectDir, store);
    setCuratorToolRuntime({ projectDir, getConfig: () => DEFAULT_CURATOR_CONFIG, isKillSwitchActive: () => false });
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('reports stale archive candidates without mutating files', async () => {
    const result = await CuratorPreviewTool.execute({});
    expect(result.success).toBe(true);
    expect(result.output).toContain('would be archived');
    expect(result.output).toContain('stale');
    // Confirm the source skill folder is still present (read-only preview).
    await expect(fs.access(path.join(projectDir, '.harness', 'skills', 'stale'))).resolves.toBeUndefined();
  });

  it('returns a deny-summary when the kill switch is active', async () => {
    setCuratorToolRuntime({ isKillSwitchActive: () => true });
    const result = await CuratorPreviewTool.execute({});
    expect(result.success).toBe(true);
    // The deterministic phase exits early with empty arrays; the tool reports
    // 0 candidates rather than failing.
    expect(result.output).toContain('0 candidate(s)');
  });
});
