import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { build, dropIndex, readIndexPrefs, writeIndexPrefs } from '../persistence/ragIndex';
import { RagListIndexesTool, RagSearchTool, setRagRuntime } from './ragTools';

describe('rag tools', () => {
  let projectDir: string;
  const ollamaHost = 'http://127.0.0.1:1';

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rag-tools-'));
    await fs.writeFile(path.join(projectDir, 'README.md'), '# Sample\n\nThis project is about agents and tools.', 'utf-8');
    setRagRuntime({ projectDir, ollamaHost });
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('rag_list_indexes reports built indexes', async () => {
    await build(projectDir, 'tool-test', ['README.md'], { backend: 'hash', ollamaHost });
    const result = await RagListIndexesTool.execute({});
    expect(result.success).toBe(true);
    expect(result.output).toContain('tool-test');
    expect(result.output).toContain('chunks');
  });

  it('rag_search returns ranked results from a built index', async () => {
    await build(projectDir, 'tool-test', ['README.md'], { backend: 'hash', ollamaHost });
    const result = await RagSearchTool.execute({ index: 'tool-test', query: 'agents' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/score=0\.\d{3}/);
    expect(result.output).toContain('README.md');
  });

  it('rag_search reports a friendly message when index is missing', async () => {
    const result = await RagSearchTool.execute({ index: 'does-not-exist', query: 'anything' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('RAG search failed');
  });

  it('rag_search rejects empty input', async () => {
    const noIndex = await RagSearchTool.execute({ index: '', query: 'q' });
    expect(noIndex.success).toBe(false);
    const noQuery = await RagSearchTool.execute({ index: 'x', query: '' });
    expect(noQuery.success).toBe(false);
  });

  it('build persists picker prefs and dropIndex removes them', async () => {
    await build(projectDir, 'pref-test', ['README.md'], { backend: 'hash', ollamaHost });
    const prefs = await readIndexPrefs(projectDir, 'pref-test');
    expect(prefs?.paths).toEqual(['README.md']);
    expect(prefs?.backend).toBe('hash');

    await writeIndexPrefs(projectDir, 'pref-test', { paths: ['README.md', 'docs'], backend: undefined });
    const updated = await readIndexPrefs(projectDir, 'pref-test');
    expect(updated?.paths).toEqual(['README.md', 'docs']);

    await dropIndex(projectDir, 'pref-test');
    const afterDrop = await readIndexPrefs(projectDir, 'pref-test');
    expect(afterDrop).toBeNull();
  });
});
