import * as fs from 'fs/promises';
import * as path from 'path';
import { FileReadTool, FileWriteTool, ListUploadsTool } from './fileTools';
import { drainUploadsFallbacks, clearFileWriteRedirectCache } from './pathResolution';

describe('file tools bounds and path safety', () => {
  const fixtureDir = path.join(process.cwd(), '.harness', 'test-fixtures', 'file-tools');
  const fixtureFile = path.join(fixtureDir, 'sample.txt');

  beforeEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(fixtureFile, 'alpha\nbeta\ngamma\ndelta', 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('rejects reads outside the project directory', async () => {
    const result = await FileReadTool.execute({ path: path.resolve(process.cwd(), '..', 'outside.txt') });

    expect(result).toMatchObject({ success: false, error: 'path outside project' });
  });

  it('returns requested one-based line ranges', async () => {
    const result = await FileReadTool.execute({ path: fixtureFile, start_line: 2, end_line: 3 });

    expect(result).toMatchObject({ success: true, output: 'beta\ngamma' });
  });

  it('truncates reads by max bytes', async () => {
    const result = await FileReadTool.execute({ path: fixtureFile, max_bytes: 5 });

    expect(result.success).toBe(true);
    expect(result.output).toContain('alpha');
    expect(result.output).toContain('truncated');
  });

  it('rejects oversized writes', async () => {
    const result = await FileWriteTool.execute({ path: path.join(fixtureDir, 'large.txt'), content: 'x'.repeat(5_000_001) });

    expect(result).toMatchObject({ success: false, error: 'write too large' });
  });

  describe('uploads fallback', () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = 'test-uploads-fallback.csv';
    const uploadPath = path.join(uploadsDir, uploadName);

    beforeEach(async () => {
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(uploadPath, 'one,two\n1,2\n', 'utf-8');
    });

    afterEach(async () => {
      await fs.rm(uploadPath, { force: true });
    });

    it('falls back to .harness/uploads when given a bare filename', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await FileReadTool.execute({ path: uploadName });

        expect(result.success).toBe(true);
        expect(result.output).toContain('one,two');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does not fall back when the basename is supplied with a different directory', async () => {
      const result = await FileReadTool.execute({ path: path.join('does-not-exist', uploadName) });

      expect(result.success).toBe(false);
    });

    it('emits a warn log when the uploads fallback is used', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await FileReadTool.execute({ path: uploadName });
        expect(result.success).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
        const lines = warnSpy.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes('PathResolution') && line.includes(uploadName))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('records a drainable uploads-fallback entry per fallback hit', async () => {
      drainUploadsFallbacks();
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await FileReadTool.execute({ path: uploadName });
        const records = drainUploadsFallbacks();
        expect(records.length).toBe(1);
        expect(records[0]).toMatchObject({ requested: uploadName });
        expect(records[0].resolved).toContain(uploadName);
        // Buffer is cleared after draining.
        expect(drainUploadsFallbacks()).toEqual([]);
      } finally {
        (console.warn as jest.Mock).mockRestore();
      }
    });
  });

  describe('list_uploads tool', () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = 'list-uploads-fixture.txt';
    const uploadPath = path.join(uploadsDir, uploadName);

    beforeEach(async () => {
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(uploadPath, 'hello', 'utf-8');
    });

    afterEach(async () => {
      await fs.rm(uploadPath, { force: true });
    });

    it('lists files in .harness/uploads with size and path', async () => {
      const result = await ListUploadsTool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain(uploadName);
      expect(result.output).toContain('5 bytes');
      expect(result.output).toContain('.harness/uploads/' + uploadName);
    });
  });

  describe('HARNESS_UPLOADS_DIR override', () => {
    const overrideDir = path.join(process.cwd(), '.harness', 'test-uploads-override');
    const overrideUploadName = 'override-upload.csv';
    const overridePath = path.join(overrideDir, overrideUploadName);

    beforeEach(async () => {
      await fs.mkdir(overrideDir, { recursive: true });
      await fs.writeFile(overridePath, 'a,b\n1,2\n', 'utf-8');
      process.env.HARNESS_UPLOADS_DIR = overrideDir;
    });

    afterEach(async () => {
      delete process.env.HARNESS_UPLOADS_DIR;
      await fs.rm(overrideDir, { recursive: true, force: true });
    });

    it('list_uploads reads from the override directory', async () => {
      const result = await ListUploadsTool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain(overrideUploadName);
    });

    it('file_read falls back through the override directory when given a bare filename', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await FileReadTool.execute({ path: overrideUploadName });
        expect(result.success).toBe(true);
        expect(result.output).toContain('a,b');
      } finally {
        (console.warn as jest.Mock).mockRestore();
      }
    });
  });

  describe('agent-outputs redirect', () => {
    // Pin to a test-only directory so tests never touch the real
    // <project>/agent-outputs/.
    const overrideDir = path.join(process.cwd(), '.harness', 'test-agent-outputs');

    beforeEach(async () => {
      await fs.rm(overrideDir, { recursive: true, force: true });
      process.env.HARNESS_AGENT_OUTPUT_DIR = overrideDir;
    });

    afterEach(async () => {
      delete process.env.HARNESS_AGENT_OUTPUT_DIR;
      await fs.rm(overrideDir, { recursive: true, force: true });
    });

    it('redirects bare-filename writes for new files into the agent-outputs dir', async () => {
      const bareName = `redir-${Date.now()}.txt`;
      const result = await FileWriteTool.execute({ path: bareName, content: 'hello' });
      expect(result.success).toBe(true);
      const expected = path.join(overrideDir, bareName);
      expect(result.output).toContain(expected);
      expect(result.output).toContain('redirected from bare filename');
      const written = await fs.readFile(expected, 'utf-8');
      expect(written).toBe('hello');
      // Must NOT have been written to the project root.
      const rootStray = path.resolve(process.cwd(), bareName);
      await expect(fs.access(rootStray)).rejects.toThrow();
    });

    it('does NOT redirect when the bare filename already exists at the project root', async () => {
      // Create a sentinel file at the project root so we can prove the
      // redirect respects existing files without ever touching package.json.
      const sentinelName = `_redir-sentinel-${Date.now()}.txt`;
      const sentinelPath = path.resolve(process.cwd(), sentinelName);
      await fs.writeFile(sentinelPath, 'original', 'utf-8');
      try {
        const result = await FileWriteTool.execute({ path: sentinelName, content: 'updated' });
        expect(result.success).toBe(true);
        expect(result.output).not.toContain('redirected');
        expect(result.output).toContain(sentinelPath);
        const after = await fs.readFile(sentinelPath, 'utf-8');
        expect(after).toBe('updated');
      } finally {
        await fs.rm(sentinelPath, { force: true });
      }
    });

    it('does NOT redirect when the path has a directory component', async () => {
      const subPath = path.join('.harness', 'test-agent-outputs-sub', `keep-${Date.now()}.txt`);
      const result = await FileWriteTool.execute({ path: subPath, content: 'subdir' });
      try {
        expect(result.success).toBe(true);
        expect(result.output).not.toContain('redirected');
        expect(result.output).toContain(path.resolve(process.cwd(), subPath));
      } finally {
        await fs.rm(path.dirname(path.resolve(process.cwd(), subPath)), { recursive: true, force: true });
      }
    });
  });

  describe('user-defined pattern redirects', () => {
    // Pin both the agent-outputs directory and the redirect destination to
    // test-only paths so a misconfigured rule never escapes the test scope.
    const agentOutputDir = path.join(process.cwd(), '.harness', 'test-agent-outputs-pat');
    const redirectDir = path.join(process.cwd(), '.harness', 'test-redirect-target');

    beforeEach(async () => {
      await fs.rm(agentOutputDir, { recursive: true, force: true });
      await fs.rm(redirectDir, { recursive: true, force: true });
      process.env.HARNESS_AGENT_OUTPUT_DIR = agentOutputDir;
      // Clear the rule cache so each test starts from the env value below.
      clearFileWriteRedirectCache();
    });

    afterEach(async () => {
      delete process.env.HARNESS_AGENT_OUTPUT_DIR;
      delete process.env.HARNESS_FILE_WRITE_REDIRECTS;
      clearFileWriteRedirectCache();
      await fs.rm(agentOutputDir, { recursive: true, force: true });
      await fs.rm(redirectDir, { recursive: true, force: true });
    });

    it('routes a glob match to the configured redirect dir, preserving basename', async () => {
      process.env.HARNESS_FILE_WRITE_REDIRECTS = JSON.stringify([
        { match: 'lottery-*', redirect: redirectDir },
      ]);
      clearFileWriteRedirectCache();
      const result = await FileWriteTool.execute({ path: 'lottery-analyzer.js', content: 'CODE' });
      expect(result.success).toBe(true);
      const expected = path.join(redirectDir, 'lottery-analyzer.js');
      expect(result.output).toContain(expected);
      expect(result.output).toContain('redirected by user pattern rule');
      const written = await fs.readFile(expected, 'utf-8');
      expect(written).toBe('CODE');
    });

    it('matches against the relative path so directory-prefixed writes still redirect', async () => {
      // The other agent writes lottery-toolkit/scripts/foo.js — must catch.
      process.env.HARNESS_FILE_WRITE_REDIRECTS = JSON.stringify([
        { match: 'lottery-toolkit/**', redirect: redirectDir },
      ]);
      clearFileWriteRedirectCache();
      const result = await FileWriteTool.execute({
        path: 'lottery-toolkit/scripts/foo.js',
        content: 'NESTED',
      });
      expect(result.success).toBe(true);
      // basename is preserved; the matched directory tree is collapsed into
      // the redirect target so files do not recreate the original layout
      // inside the redirect dir.
      const expected = path.join(redirectDir, 'foo.js');
      expect(result.output).toContain(expected);
      expect(result.output).toContain('redirected by user pattern rule');
    });

    it('first matching rule wins (order-sensitive)', async () => {
      const winnerDir = path.join(redirectDir, 'winner');
      const loserDir = path.join(redirectDir, 'loser');
      process.env.HARNESS_FILE_WRITE_REDIRECTS = JSON.stringify([
        { match: 'lottery-*', redirect: winnerDir },
        { match: '*.js', redirect: loserDir },
      ]);
      clearFileWriteRedirectCache();
      const result = await FileWriteTool.execute({ path: 'lottery-foo.js', content: 'X' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(path.join(winnerDir, 'lottery-foo.js'));
      expect(result.output).not.toContain('loser');
    });

    it('falls through to agent-outputs when no rule matches', async () => {
      process.env.HARNESS_FILE_WRITE_REDIRECTS = JSON.stringify([
        { match: 'never-matches-*', redirect: redirectDir },
      ]);
      clearFileWriteRedirectCache();
      const result = await FileWriteTool.execute({ path: `unrelated-${Date.now()}.txt`, content: 'F' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(agentOutputDir);
      expect(result.output).toContain('redirected from bare filename');
      expect(result.output).not.toContain('redirected by user pattern rule');
    });

    it('pattern rule WINS over agent-outputs when both could fire', async () => {
      process.env.HARNESS_FILE_WRITE_REDIRECTS = JSON.stringify([
        { match: '*.scratch.js', redirect: redirectDir },
      ]);
      clearFileWriteRedirectCache();
      const result = await FileWriteTool.execute({ path: 'foo.scratch.js', content: 'P' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(path.join(redirectDir, 'foo.scratch.js'));
      expect(result.output).toContain('redirected by user pattern rule');
      // Agent-outputs path must NOT be involved.
      expect(result.output).not.toContain(agentOutputDir);
    });

    it('rejects malformed env JSON silently (no rules applied)', async () => {
      process.env.HARNESS_FILE_WRITE_REDIRECTS = 'this is not JSON';
      clearFileWriteRedirectCache();
      // Should fall through to agent-outputs (no rules → normal behavior).
      const result = await FileWriteTool.execute({ path: `safe-${Date.now()}.txt`, content: 'S' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(agentOutputDir);
    });

    it('skips rule entries with empty match or empty redirect', async () => {
      process.env.HARNESS_FILE_WRITE_REDIRECTS = JSON.stringify([
        { match: '', redirect: redirectDir },
        { match: 'foo-*', redirect: '' },
        { match: 'good-*', redirect: redirectDir },
      ]);
      clearFileWriteRedirectCache();
      const result = await FileWriteTool.execute({ path: 'good-thing.js', content: 'G' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(path.join(redirectDir, 'good-thing.js'));
    });
  });
});