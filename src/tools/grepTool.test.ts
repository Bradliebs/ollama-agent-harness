import * as fs from 'fs/promises';
import * as path from 'path';
import { GrepTool } from './grepTool';

describe('grep tool bounds and path safety', () => {
  const fixtureDir = path.join(process.cwd(), '.harness', 'test-fixtures', 'grep-tool');

  beforeEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('rejects searches outside the project directory', async () => {
    const result = await GrepTool.execute({ path: path.resolve(process.cwd(), '..'), pattern: 'anything' });

    expect(result).toMatchObject({ success: false, error: 'path outside project' });
  });

  it('returns matching lines from small files', async () => {
    const filePath = path.join(fixtureDir, 'sample.txt');
    await fs.writeFile(filePath, 'alpha\nneedle\nomega', 'utf-8');

    const result = await GrepTool.execute({ path: fixtureDir, pattern: 'needle', include: '*.txt' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('sample.txt:2: needle');
  });

  it('skips files over the search byte limit', async () => {
    const largeFile = path.join(fixtureDir, 'large.txt');
    await fs.writeFile(largeFile, `${'x'.repeat(1_000_001)}unique-large-pattern`, 'utf-8');

    const result = await GrepTool.execute({ path: fixtureDir, pattern: 'unique-large-pattern', include: '*.txt' });

    expect(result).toMatchObject({ success: true, output: 'No matches found for "unique-large-pattern"' });
  });

  it('skips agent-outputs/ by default but searches it when include_scratch is true', async () => {
    // Build a fixture with a top-level file plus a scratch subdir that
    // would otherwise dominate searches.
    await fs.mkdir(path.join(fixtureDir, 'agent-outputs'), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'real.md'), 'matched-token here\n', 'utf-8');
    await fs.writeFile(path.join(fixtureDir, 'agent-outputs', 'scratch.md'), 'matched-token in scratch\n', 'utf-8');

    const defaultRun = await GrepTool.execute({ path: fixtureDir, pattern: 'matched-token' });
    expect(defaultRun.success).toBe(true);
    expect(defaultRun.output).toContain('real.md');
    expect(defaultRun.output).not.toContain('scratch.md');

    const optInRun = await GrepTool.execute({ path: fixtureDir, pattern: 'matched-token', include_scratch: true });
    expect(optInRun.success).toBe(true);
    expect(optInRun.output).toContain('real.md');
    expect(optInRun.output).toContain('scratch.md');
  });

  it('reports when it stops at the match cap and prints project-relative paths', async () => {
    await fs.writeFile(path.join(fixtureDir, 'many.txt'), Array.from({ length: 250 }, (_, i) => `hit ${i}`).join('\n'), 'utf-8');
    const result = await GrepTool.execute({ path: fixtureDir, pattern: 'hit' });
    expect(result.output.split('\n').filter((line) => line.includes(': hit '))).toHaveLength(200);
    expect(result.output).toContain('stopped at 200 matches');
    expect(result.output).toContain('.harness/test-fixtures/grep-tool/many.txt:1: hit 0');
    expect(result.output).not.toContain(process.cwd());
  });

  it('skips build output and binary files, and matches include globs on the relative path', async () => {
    await fs.mkdir(path.join(fixtureDir, 'build'), { recursive: true });
    await fs.mkdir(path.join(fixtureDir, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'build', 'out.js'), 'needle', 'utf-8');
    await fs.writeFile(path.join(fixtureDir, 'image.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    await fs.writeFile(path.join(fixtureDir, 'src', 'deep', 'a.ts'), 'needle', 'utf-8');
    await fs.writeFile(path.join(fixtureDir, 'src', 'b.js'), 'needle', 'utf-8');
    const result = await GrepTool.execute({ path: fixtureDir, pattern: 'needle', include: 'src/**/*.{ts,tsx}' });
    expect(result.output).toContain('src/deep/a.ts:1: needle');
    expect(result.output).not.toContain('b.js');
    const all = await GrepTool.execute({ path: fixtureDir, pattern: 'needle' });
    expect(all.output).not.toContain('build/out.js');
    expect(all.output).not.toContain('image.bin');
  });

  it('matches include globs from the project root too, and $ in CRLF files', async () => {
    await fs.mkdir(path.join(fixtureDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'src', 'a.ts'), 'const x = 1;\r\nconst y = 2;\r\n', 'utf-8');
    const result = await GrepTool.execute({ path: path.join(fixtureDir, 'src'), pattern: '2;$', include: '.harness/test-fixtures/grep-tool/src/**/*.ts' });
    expect(result.output).toBe('.harness/test-fixtures/grep-tool/src/a.ts:2: const y = 2;');
  });
});