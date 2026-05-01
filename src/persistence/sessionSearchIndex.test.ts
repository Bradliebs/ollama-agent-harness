import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionStorage } from './sessionStorage';
import { getSessionSearchIndexStatus, rebuildSessionSearchIndex, rebuildSessionSearchIndexWithMetadata, searchSessions } from './sessionSearchIndex';

describe('sessionSearchIndex', () => {
  it('rebuilds a derived search index from append-only transcripts', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-session-search-'));
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
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-session-search-status-'));
    const storage = new SessionStorage(projectDir, 'test-model', 'status-session');
    await storage.initialize();
    await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'First searchable message' } });

    const index = await rebuildSessionSearchIndexWithMetadata(projectDir, new Date('2026-04-30T12:00:00.000Z'));
    expect(index.metadata).toMatchObject({ sessionCount: 1, entryCount: 1, rebuiltAt: '2026-04-30T12:00:00.000Z' });
    await expect(getSessionSearchIndexStatus(projectDir)).resolves.toMatchObject({ exists: true, fresh: true, entryCount: 1 });

    await storage.append('assistant_message', { kind: 'message', message: { role: 'assistant', content: 'Second searchable message' } });

    await expect(getSessionSearchIndexStatus(projectDir)).resolves.toMatchObject({ exists: true, fresh: false, entryCount: 1 });
  });
});
