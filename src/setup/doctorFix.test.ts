import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runDoctorFix, formatDoctorFixSummary } from './doctorFix';

async function makeTmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'doctor-fix-'));
}

describe('runDoctorFix', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTmpProject();
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  describe('vision', () => {
    it('reports ok when configured vision model is installed', async () => {
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: 'llava',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest', 'qwen2.5-coder:7b'],
        pullModel: jest.fn(),
      });
      expect(result.vision.outcome).toBe('ok');
      expect(result.vision.message).toContain('llava');
    });

    it('reports ok when a vision-capable model is installed even without explicit config', async () => {
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.vision.outcome).toBe('ok');
      expect(result.vision.message).toContain('already installed');
    });

    it('skips pull without --yes when no vision model is installed', async () => {
      const pullModel = jest.fn();
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['qwen2.5-coder:7b'],
        pullModel,
      });
      expect(result.vision.outcome).toBe('skipped-confirm');
      expect(result.vision.message).toContain('--yes');
      expect(pullModel).not.toHaveBeenCalled();
    });

    it('pulls the configured vision model when --yes is passed', async () => {
      const pullModel = jest.fn().mockResolvedValue(undefined);
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: 'llava',
        contextMaxTokens: 0,
        yes: true,
        listInstalledModels: async () => ['qwen2.5-coder:7b'],
        pullModel,
      });
      expect(result.vision.outcome).toBe('pulled');
      expect(result.vision.pulledModel).toBe('llava');
      expect(pullModel).toHaveBeenCalledWith('llava');
    });

    it('falls back to llava:latest when no vision model is configured', async () => {
      const pullModel = jest.fn().mockResolvedValue(undefined);
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: true,
        listInstalledModels: async () => ['qwen2.5-coder:7b'],
        pullModel,
      });
      expect(result.vision.outcome).toBe('pulled');
      expect(result.vision.pulledModel).toBe('llava:latest');
    });

    it('reports failed when pull throws', async () => {
      const pullModel = jest.fn().mockRejectedValue(new Error('network down'));
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: true,
        listInstalledModels: async () => [],
        pullModel,
      });
      expect(result.vision.outcome).toBe('failed');
      expect(result.vision.message).toContain('network down');
    });

    it('uses confirmVisionPull callback when --yes is not passed', async () => {
      const pullModel = jest.fn().mockResolvedValue(undefined);
      const confirm = jest.fn().mockResolvedValue(true);
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: 'llava',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => [],
        pullModel,
        confirmVisionPull: confirm,
      });
      expect(confirm).toHaveBeenCalledWith('llava');
      expect(result.vision.outcome).toBe('pulled');
      expect(pullModel).toHaveBeenCalledWith('llava');
    });

    it('respects a confirmVisionPull callback returning false', async () => {
      const pullModel = jest.fn();
      const confirm = jest.fn().mockResolvedValue(false);
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: 'llava',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => [],
        pullModel,
        confirmVisionPull: confirm,
      });
      expect(result.vision.outcome).toBe('skipped-confirm');
      expect(pullModel).not.toHaveBeenCalled();
    });
  });

  describe('context', () => {
    it('reports ok when no settings.json exists', async () => {
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.context.outcome).toBe('ok');
      expect(result.context.message).toContain('runtime is already auto-mode');
    });

    it('reports ok when contextMaxTokens is already 0', async () => {
      const settingsPath = path.join(projectDir, '.harness', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ contextMaxTokens: 0 }), 'utf-8');
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.context.outcome).toBe('ok');
    });

    it('rewrites legacy default 4096 to 0 (auto)', async () => {
      const settingsPath = path.join(projectDir, '.harness', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ contextMaxTokens: 4096, model: 'foo' }, null, 2), 'utf-8');
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.context.outcome).toBe('rewritten');
      expect(result.context.previousValue).toBe(4096);
      expect(result.context.nextValue).toBe(0);
      const reread = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
      expect(reread.contextMaxTokens).toBe(0);
      expect(reread.model).toBe('foo'); // other fields preserved
    });

    it('rewrites legacy default 8192 to 0', async () => {
      const settingsPath = path.join(projectDir, '.harness', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ contextMaxTokens: 8192 }), 'utf-8');
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.context.outcome).toBe('rewritten');
    });

    it('skips rewrite when contextMaxTokens is a deliberate non-default value', async () => {
      const settingsPath = path.join(projectDir, '.harness', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ contextMaxTokens: 1024 }), 'utf-8');
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.context.outcome).toBe('skipped');
      expect(result.context.previousValue).toBe(1024);
    });

    it('reports failed when settings.json is invalid JSON', async () => {
      const settingsPath = path.join(projectDir, '.harness', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, '{not json', 'utf-8');
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.context.outcome).toBe('failed');
    });
  });

  describe('prune', () => {
    it('removes stale agent-outputs files older than the cutoff', async () => {
      const dir = path.join(projectDir, 'agent-outputs');
      await fs.mkdir(dir, { recursive: true });
      const stale = path.join(dir, 'old.md');
      const fresh = path.join(dir, 'new.md');
      await fs.writeFile(stale, 'stale');
      await fs.writeFile(fresh, 'fresh');
      // Backdate stale to 30d ago.
      const past = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
      await fs.utimes(stale, past, past);

      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        pruneMaxAgeDays: 14,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.prune.outcome).toBe('ok');
      expect(result.prune.removed).toBe(1);
      expect(result.prune.scanned).toBe(2);
      await expect(fs.access(stale)).rejects.toBeDefined();
      await expect(fs.access(fresh)).resolves.toBeUndefined();
    });

    it('reports ok with no removals when agent-outputs is missing', async () => {
      const result = await runDoctorFix({
        projectDir,
        ollamaHost: 'http://test',
        visionModel: '',
        contextMaxTokens: 0,
        yes: false,
        listInstalledModels: async () => ['llava:latest'],
      });
      expect(result.prune.outcome).toBe('ok');
      expect(result.prune.removed).toBe(0);
    });
  });

  describe('formatDoctorFixSummary', () => {
    it('renders three lines covering every fixer', async () => {
      const text = formatDoctorFixSummary({
        vision: { outcome: 'ok', message: 'installed' },
        context: { outcome: 'rewritten', message: '4096 → 0', previousValue: 4096, nextValue: 0 },
        prune: { outcome: 'ok', message: 'pruned 0', removed: 0, scanned: 0 },
      });
      expect(text).toMatch(/Vision/);
      expect(text).toMatch(/Context/);
      expect(text).toMatch(/Prune/);
      expect(text).toContain('rewritten');
    });
  });
});
