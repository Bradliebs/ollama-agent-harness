import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  deleteStructuredEntry,
  exportIdentity,
  importIdentity,
  queryStructured,
  readIdentityFile,
  readIdentitySnapshot,
  readStructuredStore,
  renderIdentityForPrompt,
  runIdentityGc,
  upsertStructuredEntry,
  writeIdentityFile,
} from './identity';

describe('identity layer', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-identity-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns sensible defaults when no files exist', async () => {
    const snapshot = await readIdentitySnapshot(projectDir);
    expect(snapshot.soul).toContain('# Soul');
    expect(snapshot.user).toContain('# User');
    expect(snapshot.structured.entries).toEqual([]);
  });

  it('reads back what it wrote', async () => {
    await writeIdentityFile(projectDir, 'SOUL.md', '# Custom soul\nI am a careful operator.');
    const soul = await readIdentityFile(projectDir, 'SOUL.md');
    expect(soul).toContain('careful operator');
  });

  it('upserts structured entries and supports update on the same id', async () => {
    const a = await upsertStructuredEntry(projectDir, { id: 'project-x', category: 'project', summary: 'Project X is the harness gap analysis.' });
    expect(a.id).toBe('project-x');
    const updated = await upsertStructuredEntry(projectDir, { id: 'project-x', category: 'project', summary: 'Project X — gap analysis (now in cycle 5).' });
    expect(updated.summary).toContain('cycle 5');
    const store = await readStructuredStore(projectDir);
    expect(store.entries).toHaveLength(1);
  });

  it('queries by category and free-text', async () => {
    await upsertStructuredEntry(projectDir, { category: 'project', summary: 'Harness CLAW gap analysis' });
    await upsertStructuredEntry(projectDir, { category: 'preference', summary: 'Prefers concise answers' });
    expect(await queryStructured(projectDir, { category: 'preference' })).toHaveLength(1);
    const matches = await queryStructured(projectDir, { q: 'harness' });
    expect(matches.some((entry) => entry.summary.toLowerCase().includes('harness'))).toBe(true);
  });

  it('deletes structured entries', async () => {
    const created = await upsertStructuredEntry(projectDir, { id: 'tmp', category: 'note', summary: 'temp' });
    expect(await deleteStructuredEntry(projectDir, created.id)).toBe(true);
    expect(await deleteStructuredEntry(projectDir, created.id)).toBe(false);
    expect((await readStructuredStore(projectDir)).entries).toEqual([]);
  });

  it('renderIdentityForPrompt skips empty defaults', async () => {
    const empty = await renderIdentityForPrompt(projectDir);
    expect(empty).toBe('');
    await writeIdentityFile(projectDir, 'USER.md', 'Brad prefers brief answers.');
    await upsertStructuredEntry(projectDir, { category: 'preference', summary: 'Concise output' });
    const rendered = await renderIdentityForPrompt(projectDir);
    expect(rendered).toContain('## User');
    expect(rendered).toContain('Brad prefers brief answers');
    expect(rendered).toContain('## Structured facts');
  });

  it('renderIdentityForPrompt truncates over budget', async () => {
    await writeIdentityFile(projectDir, 'SOUL.md', 'X'.repeat(10_000));
    const rendered = await renderIdentityForPrompt(projectDir, { maxChars: 500 });
    expect(rendered.length).toBeLessThan(600);
    expect(rendered).toContain('truncated');
  });

  it('exports a snapshot and re-imports it via merge mode', async () => {
    await writeIdentityFile(projectDir, 'SOUL.md', '# Custom Soul\nValues here.');
    await upsertStructuredEntry(projectDir, { id: 'pref-1', category: 'preference', summary: 'concise replies' });
    const exported = await exportIdentity(projectDir);
    expect(exported.version).toBe(1);
    expect(exported.snapshot.structured.entries).toHaveLength(1);

    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-identity-import-'));
    try {
      const summary = await importIdentity(otherDir, exported);
      expect(summary.importedSoul).toBe(true);
      expect(summary.importedStructured).toBe(1);
      const reread = await readIdentitySnapshot(otherDir);
      expect(reread.soul).toContain('Custom Soul');
      expect(reread.structured.entries).toHaveLength(1);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it('replace mode overwrites the structured store', async () => {
    await upsertStructuredEntry(projectDir, { id: 'old-1', category: 'note', summary: 'should be gone' });
    await importIdentity(projectDir, {
      snapshot: { soul: '', user: '', structured: { version: 1, entries: [{ id: 'new-1', category: 'note', summary: 'fresh', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] } },
    }, { mergeStructured: false });
    const store = await readStructuredStore(projectDir);
    expect(store.entries.map((entry) => entry.id)).toEqual(['new-1']);
  });

  it('rejects malformed import payloads', async () => {
    await expect(importIdentity(projectDir, null)).rejects.toThrow();
    await expect(importIdentity(projectDir, {})).rejects.toThrow();
  });

  it('runIdentityGc drops stale entries and keeps pinned ones', async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    // Bypass upsert so we can inject custom timestamps.
    const store = { version: 1 as const, entries: [
      { id: 'stale-1', category: 'note', summary: 'old', createdAt: old, updatedAt: old },
      { id: 'pinned', category: 'pref', summary: 'always keep', metadata: { pinned: true }, createdAt: old, updatedAt: old },
      { id: 'fresh', category: 'note', summary: 'new', createdAt: recent, updatedAt: recent },
    ] };
    await fs.mkdir(path.join(projectDir, '.harness', 'identity'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.harness', 'identity', 'structured.json'), JSON.stringify(store), 'utf-8');
    const summary = await runIdentityGc(projectDir, { maxAgeDays: 90 });
    expect(summary.scanned).toBe(3);
    expect(summary.removed).toBe(1);
    expect(summary.pinnedKept).toBe(1);
    const remaining = await readStructuredStore(projectDir);
    expect(remaining.entries.map((entry) => entry.id).sort()).toEqual(['fresh', 'pinned']);
  });
});
