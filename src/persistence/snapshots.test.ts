import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { take, list, get, diff, restore } from './snapshots';

describe('snapshots', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-test-'));
    // Create the tracked paths so snapshots have content to capture.
    const skillsDir = path.join(tmpDir, '.harness', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'test-skill.md'), '# Test Skill\n\nDoes things.', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.harness', 'MEMORY.md'), '# Memory\n\nRemember this.', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('takes a snapshot and returns valid metadata', async () => {
    const meta = await take(tmpDir, 'unit test');
    expect(meta.id).toMatch(/^snap-/);
    expect(meta.reason).toBe('unit test');
    expect(meta.fileCount).toBeGreaterThanOrEqual(2);
    expect(meta.totalBytes).toBeGreaterThan(0);
    expect(meta.createdAt).toBeTruthy();
  });

  it('lists snapshots in reverse chronological order', async () => {
    const first = await take(tmpDir, 'first');
    const second = await take(tmpDir, 'second');
    const result = await list(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(second.id);
    expect(result[1].id).toBe(first.id);
  });

  it('lists empty when no snapshots exist', async () => {
    const result = await list(tmpDir);
    expect(result).toEqual([]);
  });

  it('retrieves a snapshot payload by id', async () => {
    const meta = await take(tmpDir, 'get test');
    const payload = await get(tmpDir, meta.id);
    expect(payload).not.toBeNull();
    expect(payload!.version).toBe(1);
    expect(payload!.files.length).toBe(meta.fileCount);
    const memFile = payload!.files.find((f) => f.path.includes('MEMORY.md'));
    expect(memFile).toBeDefined();
    expect(memFile!.content).toContain('Remember this');
  });

  it('returns null for nonexistent snapshot id', async () => {
    expect(await get(tmpDir, 'nonexistent')).toBeNull();
  });

  it('sanitizes unsafe characters in snapshot id', async () => {
    expect(await get(tmpDir, '../../../etc/passwd')).toBeNull();
  });

  it('diffs a snapshot against current state', async () => {
    const meta = await take(tmpDir, 'diff base');
    // Modify a tracked file.
    await fs.writeFile(path.join(tmpDir, '.harness', 'MEMORY.md'), '# Memory\n\nChanged content.', 'utf-8');
    // Add a new tracked file.
    await fs.writeFile(path.join(tmpDir, '.harness', 'USER.md'), '# User\n\nNew file.', 'utf-8');
    const result = await diff(tmpDir, meta.id);
    expect(result).not.toBeNull();
    expect(result!.modified).toContain('.harness/MEMORY.md');
    expect(result!.added).toContain('.harness/USER.md');
    expect(result!.removed).toEqual([]);
  });

  it('restores a snapshot and creates a safety snapshot', async () => {
    const original = await take(tmpDir, 'original');
    // Modify the file.
    await fs.writeFile(path.join(tmpDir, '.harness', 'MEMORY.md'), '# Memory\n\nDirty state.', 'utf-8');
    const result = await restore(tmpDir, original.id);
    expect(result).not.toBeNull();
    expect(result!.restoredFiles).toBe(original.fileCount);
    expect(result!.safetySnapshotId).toMatch(/^snap-/);
    // Verify content was restored.
    const restored = await fs.readFile(path.join(tmpDir, '.harness', 'MEMORY.md'), 'utf-8');
    expect(restored).toContain('Remember this');
  });

  it('returns null when restoring nonexistent snapshot', async () => {
    expect(await restore(tmpDir, 'fake-id')).toBeNull();
  });
});
