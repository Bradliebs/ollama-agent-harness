import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readIdentitySnapshot,
  upsertStructuredEntry,
  writeIdentityFile,
} from './identity';
import {
  captureIdentitySnapshot,
  listIdentityHistory,
  loadIdentityHistory,
  restoreIdentityFromHistory,
} from './identityHistory';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'identity-history-test-'));
}

describe('identity history layer', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('listIdentityHistory returns [] before any snapshot exists', async () => {
    const items = await listIdentityHistory(dir);
    expect(items).toEqual([]);
  });

  it('captureIdentitySnapshot writes SOUL/USER/structured/meta into a new directory', async () => {
    await writeIdentityFile(dir, 'SOUL.md', '# Soul v1\nVoice: terse.');
    await writeIdentityFile(dir, 'USER.md', '# User\nBrad ships to dev.');
    await upsertStructuredEntry(dir, { category: 'preference', summary: 'prefers brief replies' });

    const meta = await captureIdentitySnapshot(dir, 'manual capture');
    expect(meta.id).toMatch(/manual-capture$/);
    expect(meta.reason).toBe('manual capture');

    const snapshotDir = path.join(dir, '.harness', 'identity', 'history', meta.id);
    const files = await fs.readdir(snapshotDir);
    expect(files.sort()).toEqual(['SOUL.md', 'USER.md', 'meta.json', 'structured.json']);
  });

  it('loadIdentityHistory round-trips what was captured', async () => {
    await writeIdentityFile(dir, 'SOUL.md', '# Soul A');
    await writeIdentityFile(dir, 'USER.md', '# User A');
    await upsertStructuredEntry(dir, { category: 'fact', summary: 'fact A' });
    const meta = await captureIdentitySnapshot(dir, 'first');

    const loaded = await loadIdentityHistory(dir, meta.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.snapshot.soul).toContain('Soul A');
    expect(loaded!.snapshot.user).toContain('User A');
    expect(loaded!.snapshot.structured.entries.map((e) => e.summary)).toContain('fact A');
  });

  it('loadIdentityHistory returns null for an unknown id', async () => {
    const loaded = await loadIdentityHistory(dir, 'does-not-exist');
    expect(loaded).toBeNull();
  });

  it('listIdentityHistory returns most-recent-first ordering', async () => {
    await writeIdentityFile(dir, 'SOUL.md', '# v1');
    const a = await captureIdentitySnapshot(dir, 'one', new Date('2026-01-01T10:00:00Z'));
    const b = await captureIdentitySnapshot(dir, 'two', new Date('2026-01-02T10:00:00Z'));
    const c = await captureIdentitySnapshot(dir, 'three', new Date('2026-01-03T10:00:00Z'));
    const items = await listIdentityHistory(dir);
    expect(items.map((m) => m.id)).toEqual([c.id, b.id, a.id]);
  });

  it('captureIdentitySnapshot does not clobber a same-instant collision', async () => {
    const fixed = new Date('2026-06-07T11:30:00Z');
    const first = await captureIdentitySnapshot(dir, 'same', fixed);
    const second = await captureIdentitySnapshot(dir, 'same', fixed);
    expect(first.id).not.toBe(second.id);
    const items = await listIdentityHistory(dir);
    expect(items).toHaveLength(2);
  });

  it('restoreIdentityFromHistory reverts live files and backs up current state first', async () => {
    // v1 — capture
    await writeIdentityFile(dir, 'SOUL.md', '# Soul v1\nOriginal voice.');
    await writeIdentityFile(dir, 'USER.md', '# User v1');
    const v1 = await captureIdentitySnapshot(dir, 'v1 baseline');

    // Drift to v2
    await writeIdentityFile(dir, 'SOUL.md', '# Soul v2\nDrifted voice.');
    await writeIdentityFile(dir, 'USER.md', '# User v2');

    // Restore v1
    const result = await restoreIdentityFromHistory(dir, v1.id);
    expect(result).not.toBeNull();
    expect(result!.restored.id).toBe(v1.id);
    expect(result!.backup.reason).toBe(`pre-restore-${v1.id}`);

    // Live files now match v1.
    const live = await readIdentitySnapshot(dir);
    expect(live.soul).toContain('Soul v1');
    expect(live.user).toContain('User v1');

    // The drifted v2 state is recoverable from the backup snapshot.
    const backup = await loadIdentityHistory(dir, result!.backup.id);
    expect(backup).not.toBeNull();
    expect(backup!.snapshot.soul).toContain('Soul v2');
  });

  it('restoreIdentityFromHistory returns null when the id does not exist', async () => {
    const result = await restoreIdentityFromHistory(dir, 'nope');
    expect(result).toBeNull();
  });

  it('captures and restores structured entries verbatim', async () => {
    await upsertStructuredEntry(dir, { id: 'pref-tone', category: 'preference', summary: 'terse' });
    await upsertStructuredEntry(dir, { id: 'pref-shape', category: 'preference', summary: 'no preamble' });
    const snap = await captureIdentitySnapshot(dir, 'with structured');

    // Mutate after capture.
    await upsertStructuredEntry(dir, { id: 'pref-tone', category: 'preference', summary: 'verbose' });

    await restoreIdentityFromHistory(dir, snap.id);
    const live = await readIdentitySnapshot(dir);
    const tone = live.structured.entries.find((e) => e.id === 'pref-tone');
    expect(tone?.summary).toBe('terse');
  });
});
