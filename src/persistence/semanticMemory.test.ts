import * as fs from 'fs/promises';
import * as path from 'path';
import { MEMORY_INDEX_RETENTION_LIMITS } from './memoryIndexRetention';
import { SessionStorage } from './sessionStorage';
import { buildMemoryPalace, getSemanticMemoryContext, getSemanticMemoryEntry, rebuildSemanticMemory, searchSemanticMemory } from './semanticMemory';

describe('semanticMemory', () => {
  const testRoot = path.join(process.cwd(), '.harness', 'test-workspaces', 'semantic-memory');

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  async function makeProjectDir(prefix: string): Promise<string> {
    await fs.mkdir(testRoot, { recursive: true });
    return fs.mkdtemp(path.join(testRoot, `${prefix}-`));
  }

  it('indexes session transcripts and ranks relevant matches', async () => {
    const projectDir = await makeProjectDir('harness-memory');
    const storage = new SessionStorage(projectDir, 'test-model', 'memory-session');
    await storage.initialize();
    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'Implement recovery checkpoints for session resume' },
    });
    await storage.append('assistant_message', {
      kind: 'message',
      message: { role: 'assistant', content: 'Added semantic memory indexing and fork support' },
    });

    const entries = await rebuildSemanticMemory(projectDir);
    const results = await searchSemanticMemory(projectDir, 'resume recovery checkpoint');

    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(results[0].entry.text).toContain('recovery checkpoints');
  });

  it('builds memory palace rooms from semantic entries', async () => {
    const projectDir = await makeProjectDir('harness-palace');
    const storage = new SessionStorage(projectDir, 'test-model', 'palace-session');
    await storage.initialize();
    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'Design a memory palace for session recall' },
    });
    await storage.append('tool_result', {
      kind: 'tool_result',
      call: { name: 'grep', input: {} },
      result: { success: true, output: 'Found semantic memory references' },
    });

    await rebuildSemanticMemory(projectDir);
    const palace = await buildMemoryPalace(projectDir);

    expect(palace.entryCount).toBeGreaterThanOrEqual(2);
    expect(palace.rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'conversation', title: 'Conversation Gallery' }),
      expect.objectContaining({ id: 'tools', title: 'Tool Workshop' }),
    ]));
  });

  it('loads a semantic memory entry by id', async () => {
    const projectDir = await makeProjectDir('harness-entry');
    const storage = new SessionStorage(projectDir, 'test-model', 'entry-session');
    await storage.initialize();
    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'Open the memory palace anchor detail' },
    });

    const entries = await rebuildSemanticMemory(projectDir);
    const entry = await getSemanticMemoryEntry(projectDir, entries[0].id);

    expect(entry).toMatchObject({ id: entries[0].id, sessionId: 'entry-session' });
  });

  it('returns bounded transcript context around a memory entry', async () => {
    const projectDir = await makeProjectDir('harness-context');
    const storage = new SessionStorage(projectDir, 'test-model', 'context-session');
    await storage.initialize();
    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'Before the anchor' },
    });
    await storage.append('assistant_message', {
      kind: 'message',
      message: { role: 'assistant', content: 'Anchor transcript event' },
    });
    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'After the anchor' },
    });

    const entries = await rebuildSemanticMemory(projectDir);
    const anchor = entries.find((entry) => entry.text === 'Anchor transcript event');
    const context = await getSemanticMemoryContext(projectDir, anchor?.id ?? '', 1);

    expect(context?.events.map((event) => event.text)).toEqual([
      'Before the anchor',
      'Anchor transcript event',
      'After the anchor',
    ]);
    expect(context?.events[1]).toMatchObject({ isAnchor: true, sessionId: 'context-session' });
  });

  it('writes a retained index with bounded entry text and tokens', async () => {
    const projectDir = await makeProjectDir('harness-retention');
    const storage = new SessionStorage(projectDir, 'test-model', 'retention-session');
    const longText = [
      'needle-at-start',
      'x'.repeat(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars + 100),
    ].join(' ');
    await storage.initialize();
    await storage.append('tool_result', {
      kind: 'tool_result',
      call: { name: 'read', input: {} },
      result: { success: true, output: longText },
    });

    const entries = await rebuildSemanticMemory(projectDir);
    const index = JSON.parse(await fs.readFile(path.join(projectDir, '.harness', 'memory', 'semantic-index.json'), 'utf-8'));
    const results = await searchSemanticMemory(projectDir, 'needle-at-start');

    expect(entries[0].text).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars);
    expect(index[0].text).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars);
    expect(index[0].tokens.length).toBeLessThanOrEqual(MEMORY_INDEX_RETENTION_LIMITS.maxTokens);
    expect(results[0].entry.text).toContain('needle-at-start');
  });
});
