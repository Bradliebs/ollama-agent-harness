import * as fs from 'fs/promises';
import * as path from 'path';
import { FileReadTool, FileWriteTool } from './fileTools';

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
});