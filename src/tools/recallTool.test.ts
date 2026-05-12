import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { upsertEntity } from '../jarvis/knowledgeGraph';
import { createRecallTool } from './recallTool';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-recall-'));
}

describe('recall tool', () => {
  it('returns no-matches message on empty graph', async () => {
    const dir = await tmpDir();
    const tool = createRecallTool(dir);
    const result = await tool.execute({ query: 'anything' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/No matches/);
  });

  it('returns entities matching the query', async () => {
    const dir = await tmpDir();
    await upsertEntity(dir, 'file', 'src/payment.ts', { owner: 'alice' }, 'test');
    const tool = createRecallTool(dir);
    const result = await tool.execute({ query: 'payment' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/payment\.ts/);
  });

  it('errors on missing query', async () => {
    const dir = await tmpDir();
    const tool = createRecallTool(dir);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
  });

  it('respects the limit parameter', async () => {
    const dir = await tmpDir();
    for (let i = 0; i < 5; i++) await upsertEntity(dir, 'file', `file${i}.ts`, {}, 'test');
    const tool = createRecallTool(dir);
    const result = await tool.execute({ query: 'file', limit: 2 });
    expect(result.success).toBe(true);
    const entityLines = result.output.split('\n').filter((l: string) => l.startsWith('entity '));
    expect(entityLines.length).toBeLessThanOrEqual(2);
  });
});
