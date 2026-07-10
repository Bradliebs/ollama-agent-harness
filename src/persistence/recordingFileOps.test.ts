import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { writeFileTracked, deleteFileTracked } from './recordingFileOps';
import { listSideEffects } from './sideEffectLedger';
import { revertRun } from './runReverter';

describe('recordingFileOps', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-recops-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('records a create when the file did not exist', async () => {
    const fx = await writeFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'new.txt', content: 'hi' });
    expect(fx.kind).toBe('file_create');
    expect(fx.reversal).toEqual({ kind: 'delete_file', path: 'new.txt' });
    expect(await fs.readFile(path.join(tmpDir, 'new.txt'), 'utf-8')).toBe('hi');
  });

  it('records a modify capturing prior content when the file existed', async () => {
    await fs.writeFile(path.join(tmpDir, 'f.txt'), 'old', 'utf-8');
    const fx = await writeFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'f.txt', content: 'new' });
    expect(fx.kind).toBe('file_modify');
    expect(fx.reversal).toEqual({ kind: 'restore_file', path: 'f.txt', previousContent: 'old' });
    expect(await fs.readFile(path.join(tmpDir, 'f.txt'), 'utf-8')).toBe('new');
  });

  it('creates parent directories for a nested write', async () => {
    await writeFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'a/b/c.txt', content: 'x' });
    expect(await fs.readFile(path.join(tmpDir, 'a', 'b', 'c.txt'), 'utf-8')).toBe('x');
  });

  it('records a delete capturing prior content, and is a no-op for a missing file', async () => {
    await fs.writeFile(path.join(tmpDir, 'gone.txt'), 'bye', 'utf-8');
    const fx = await deleteFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'gone.txt' });
    expect(fx?.kind).toBe('file_delete');
    expect(fx?.reversal).toEqual({ kind: 'restore_file', path: 'gone.txt', previousContent: 'bye' });
    await expect(fs.access(path.join(tmpDir, 'gone.txt'))).rejects.toThrow();

    const missing = await deleteFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'never.txt' });
    expect(missing).toBeNull();
  });

  it('produces effects that revertRun can undo end-to-end', async () => {
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'original', 'utf-8');
    await writeFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'existing.txt', content: 'changed' });
    await writeFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'created.txt', content: 'fresh' });
    await deleteFileTracked({ projectDir: tmpDir, runId: 'run-1', filePath: 'existing.txt' }); // delete the now-modified one

    expect(await listSideEffects(tmpDir, 'run-1')).toHaveLength(3);

    const result = await revertRun(tmpDir, 'run-1');
    expect(result.reverted).toHaveLength(3);
    expect(result.failed).toEqual([]);
    // existing.txt: deleted last -> restored to its modified content first, then
    // restored to original by the modify reversal -> ends as 'original'.
    expect(await fs.readFile(path.join(tmpDir, 'existing.txt'), 'utf-8')).toBe('original');
    // created.txt: create reversal deletes it.
    await expect(fs.access(path.join(tmpDir, 'created.txt'))).rejects.toThrow();
  });
});
