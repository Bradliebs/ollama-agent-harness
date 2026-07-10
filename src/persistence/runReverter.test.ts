import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { recordSideEffect, listSideEffects } from './sideEffectLedger';
import { revertRun } from './runReverter';

describe('runReverter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-revert-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('deletes a created file and restores a modified one in a single undo', async () => {
    // Simulate a run: modified existing.txt (was "old") and created new.txt.
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'NEW CONTENT', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'new.txt'), 'fresh', 'utf-8');
    await recordSideEffect(tmpDir, {
      runId: 'run-1', kind: 'file_modify', description: 'edit existing.txt',
      reversal: { kind: 'restore_file', path: 'existing.txt', previousContent: 'old' },
    });
    await recordSideEffect(tmpDir, {
      runId: 'run-1', kind: 'file_create', description: 'create new.txt',
      reversal: { kind: 'delete_file', path: 'new.txt' },
    });

    const result = await revertRun(tmpDir, 'run-1');

    expect(result.reverted).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(await fs.readFile(path.join(tmpDir, 'existing.txt'), 'utf-8')).toBe('old');
    await expect(fs.access(path.join(tmpDir, 'new.txt'))).rejects.toThrow();

    // Effects are now marked reversed; a second undo does nothing.
    const second = await revertRun(tmpDir, 'run-1');
    expect(second.reverted).toEqual([]);
    expect(second.alreadyReversed).toHaveLength(2);
  });

  it('reports irreversible effects without touching them', async () => {
    await recordSideEffect(tmpDir, {
      runId: 'run-1', kind: 'notification', description: 'sent a message',
      reversal: { kind: 'irreversible', reason: 'message already delivered' },
    });

    const result = await revertRun(tmpDir, 'run-1');

    expect(result.reverted).toEqual([]);
    expect(result.irreversible).toHaveLength(1);
    expect(result.irreversible[0].description).toBe('sent a message');
    // Irreversible effects stay un-reversed in the ledger.
    const all = await listSideEffects(tmpDir, 'run-1');
    expect(all[0].reversed).toBe(false);
  });

  it('treats an already-deleted target as success for delete_file', async () => {
    await recordSideEffect(tmpDir, {
      runId: 'run-1', kind: 'file_create', description: 'create gone.txt',
      reversal: { kind: 'delete_file', path: 'gone.txt' }, // never written
    });

    const result = await revertRun(tmpDir, 'run-1');

    expect(result.reverted).toHaveLength(1);
    expect(result.failed).toEqual([]);
  });

  it('only reverts effects belonging to the requested run', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'y', 'utf-8');
    await recordSideEffect(tmpDir, {
      runId: 'run-1', kind: 'file_create', description: 'a',
      reversal: { kind: 'delete_file', path: 'a.txt' },
    });
    await recordSideEffect(tmpDir, {
      runId: 'run-2', kind: 'file_create', description: 'b',
      reversal: { kind: 'delete_file', path: 'b.txt' },
    });

    await revertRun(tmpDir, 'run-1');

    await expect(fs.access(path.join(tmpDir, 'a.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf-8')).toBe('y');
  });
});
