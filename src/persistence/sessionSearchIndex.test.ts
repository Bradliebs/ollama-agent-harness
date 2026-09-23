import * as fs from 'fs/promises';
import * as path from 'path';
import { MEMORY_INDEX_RETENTION_LIMITS } from './memoryIndexRetention';
import { SessionStorage } from './sessionStorage';
import { getSessionSearchIndexStatus, rebuildSessionSearchIndex, rebuildSessionSearchIndexWithMetadata, searchSessions } from './sessionSearchIndex';

describe('sessionSearchIndex', () => {
  const testRoot = path.join(process.cwd(), '.harness', 'test-workspaces', 'session-search-index');

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  async function makeProjectDir(prefix: string): Promise<string> {
    await fs.mkdir(testRoot, { recursive: true });
    return fs.mkdtemp(path.join(testRoot, `${prefix}-`));
  }

  it('rebuilds a derived search index from append-only transcripts', async () => {
    const projectDir = await makeProjectDir('harness-session-search');
    const storage = new SessionStorage(projectDir, 'test-model', 'search-session');
    await storage.initialize();
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'Investigate automation trigger failures' } });
    await storage.append('assistant_message', { kind: 'message', message: { role: 'assistant', content: 'The automation runner needs durable output files' } });

    const entries = await rebuildSessionSearchIndex(projectDir);
    const results = await searchSessions(projectDir, 'automation output');

    expect(entries).toHaveLength(2);
    expect(results[0].entry.text).toContain('automation runner');
  });

  it('writes metadata and reports stale status when sessions change', async () => {
    const projectDir = await makeProjectDir('harness-session-search-status');
    const storage = new SessionStorage(projectDir, 'test-model', 'status-session');
    await storage.initialize();
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'First searchable message' } });

    const index = await rebuildSessionSearchIndexWithMetadata(projectDir, new Date('2026-04-30T12:00:00.000Z'));
    expect(index.metadata).toMatchObject({ sessionCount: 1, entryCount: 1, rebuiltAt: '2026-04-30T12:00:00.000Z' });
    await expect(getSessionSearchIndexStatus(projectDir)).resolves.toMatchObject({ exists: true, fresh: true, entryCount: 1 });

    await storage.append('assistant_message', { kind: 'message', message: { role: 'assistant', content: 'Second searchable message' } });

    await expect(getSessionSearchIndexStatus(projectDir)).resolves.toMatchObject({ exists: true, fresh: false, entryCount: 1 });
  });

  it('returns empty results for empty query string', async () => {
    const projectDir = await makeProjectDir('harness-session-search-empty');
    const storage = new SessionStorage(projectDir, 'test-model', 'empty-query-session');
    await storage.initialize();
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'Some content here' } });
    await rebuildSessionSearchIndex(projectDir);
    const results = await searchSessions(projectDir, '');
    expect(results).toEqual([]);
  });

  it('returns empty results for non-matching query', async () => {
    const projectDir = await makeProjectDir('harness-session-search-nomatch');
    const storage = new SessionStorage(projectDir, 'test-model', 'nomatch-session');
    await storage.initialize();
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'Hello world' } });
    await rebuildSessionSearchIndex(projectDir);
    const results = await searchSessions(projectDir, 'xyzzyspoon');
    expect(results).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    const projectDir = await makeProjectDir('harness-session-search-limit');
    const storage = new SessionStorage(projectDir, 'test-model', 'limit-session');
    await storage.initialize();
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'test query alpha' } });
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'test query beta' } });
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'test query gamma' } });
    await rebuildSessionSearchIndex(projectDir);
    const results = await searchSessions(projectDir, 'test query', 1);
    expect(results).toHaveLength(1);
  });

  it('returns empty index for empty project', async () => {
    const projectDir = await makeProjectDir('harness-session-search-nodata');
    const result = await rebuildSessionSearchIndexWithMetadata(projectDir);
    expect(result.entries).toEqual([]);
    expect(result.metadata.sessionCount).toBe(0);
    expect(result.metadata.entryCount).toBe(0);
  });

  it('reports not-exists when no index has been built', async () => {
    const projectDir = await makeProjectDir('harness-session-search-noindex');
    const status = await getSessionSearchIndexStatus(projectDir);
    expect(status.exists).toBe(false);
    expect(status.fresh).toBe(false);
  });

  it('writes retained entries and metadata after truncating oversized content', async () => {
    const projectDir = await makeProjectDir('harness-session-search-retention');
    const storage = new SessionStorage(projectDir, 'test-model', 'retention-session');
    const longText = [
      'session-search-needle',
      'x'.repeat(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars + 100),
    ].join(' ');
    await storage.initialize();
    await storage.append('tool_result', {
      kind: 'tool_result',
      call: { name: 'read', input: {} },
      result: { success: true, output: longText },
    });

    const index = await rebuildSessionSearchIndexWithMetadata(projectDir);
    const diskIndex = JSON.parse(await fs.readFile(path.join(projectDir, '.harness', 'memory', 'session-search-index.json'), 'utf-8'));
    const results = await searchSessions(projectDir, 'session-search-needle');

    expect(index.metadata.entryCount).toBe(1);
    expect(index.entries[0].text).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars);
    expect(diskIndex.entries[0].text).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars);
    expect(diskIndex.entries[0].tokens.length).toBeLessThanOrEqual(MEMORY_INDEX_RETENTION_LIMITS.maxTokens);
    expect(results[0].entry.text).toContain('session-search-needle');
  });
});
