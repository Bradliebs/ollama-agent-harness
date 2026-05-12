import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { recordPermissionOutcome } from './permissionFeedback';
import { loadTrustLadder } from './trustLadder';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-permfb-'));
}

describe('permission feedback', () => {
  it('records an accepted outcome on allow', async () => {
    const dir = await tmpDir();
    await recordPermissionOutcome(dir, 'bash', 'allowed');
    const snap = await loadTrustLadder(dir);
    expect(snap.capabilities.bash.acceptedStreak).toBe(1);
  });

  it('records a rejected outcome on deny', async () => {
    const dir = await tmpDir();
    await recordPermissionOutcome(dir, 'bash', 'denied');
    const snap = await loadTrustLadder(dir);
    expect(snap.capabilities.bash.rejectedStreak).toBe(1);
  });

  it('skip option short-circuits', async () => {
    const dir = await tmpDir();
    await recordPermissionOutcome(dir, 'bash', 'allowed', { skip: true });
    const snap = await loadTrustLadder(dir);
    expect(snap.capabilities.bash).toBeUndefined();
  });

  it('honors capability override', async () => {
    const dir = await tmpDir();
    await recordPermissionOutcome(dir, 'file_write', 'allowed', { capability: 'self_modify' });
    const snap = await loadTrustLadder(dir);
    expect(snap.capabilities.self_modify).toBeDefined();
  });

  it('promotes after 5 acceptances', async () => {
    const dir = await tmpDir();
    for (let i = 0; i < 5; i++) await recordPermissionOutcome(dir, 'grep', 'allowed');
    const snap = await loadTrustLadder(dir);
    expect(snap.capabilities.grep.rung).toBe(3);
  });
});
