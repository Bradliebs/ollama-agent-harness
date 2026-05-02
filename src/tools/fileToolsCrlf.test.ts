import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FileEditTool } from './fileTools';

/**
 * Coverage for FileEditTool's CRLF-aware matching. Models on Windows
 * checkouts often emit \n line endings while the file on disk has \r\n,
 * which used to cause "String not found" failures even when the model
 * had the correct content.
 */
describe('FileEditTool CRLF tolerance', () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let target: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-edit-crlf-'));
    process.chdir(workDir);
    target = path.join(workDir, 'sample.ts');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('replaces an exact LF match unchanged', async () => {
    await fs.writeFile(target, "line1\nline2\nline3\n", 'utf-8');
    const result = await FileEditTool.execute({
      path: 'sample.ts',
      old_string: 'line2',
      new_string: 'replaced',
    });
    expect(result.success).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe("line1\nreplaced\nline3\n");
  });

  it('replaces a multi-line LF match in a CRLF file (model emits \\n, file has \\r\\n)', async () => {
    await fs.writeFile(target, "alpha\r\nbeta\r\ngamma\r\ndelta\r\n", 'utf-8');
    const result = await FileEditTool.execute({
      path: 'sample.ts',
      old_string: 'beta\ngamma',
      new_string: 'BETA\nGAMMA',
    });
    expect(result.success).toBe(true);
    // The replacement preserves the file's existing line endings around the edit
    // because we only swap the matched span's bytes for the new_string.
    const after = await fs.readFile(target, 'utf-8');
    expect(after).toContain('BETA\nGAMMA');
    expect(after.startsWith('alpha\r\n')).toBe(true);
    expect(after.endsWith('delta\r\n')).toBe(true);
  });

  it('still reports "String not found" when the content really is absent', async () => {
    await fs.writeFile(target, "alpha\r\nbeta\r\n", 'utf-8');
    const result = await FileEditTool.execute({
      path: 'sample.ts',
      old_string: 'omega',
      new_string: 'X',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('String not found');
  });

  it('detects ambiguous matches even after CRLF normalization', async () => {
    await fs.writeFile(target, "line\r\nline\r\n", 'utf-8');
    const result = await FileEditTool.execute({
      path: 'sample.ts',
      old_string: 'line',
      new_string: 'X',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Multiple matches');
  });

  it('handles a single-line LF match against a single-line CRLF file', async () => {
    await fs.writeFile(target, "alpha-beta-gamma\r\n", 'utf-8');
    const result = await FileEditTool.execute({
      path: 'sample.ts',
      old_string: 'alpha-beta-gamma',
      new_string: 'replaced',
    });
    expect(result.success).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('replaced\r\n');
  });

  it('reports path safety failure when path escapes project dir', async () => {
    const result = await FileEditTool.execute({
      path: '../../../etc/passwd',
      old_string: 'x',
      new_string: 'y',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('outside the project directory');
  });
});
