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
});