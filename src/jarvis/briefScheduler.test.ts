import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { snapshotDailyBrief } from './briefScheduler';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-brief-'));
}

describe('brief scheduler', () => {
  it('produces a markdown snapshot for an empty project', async () => {
    const dir = await tmpDir();
    const snap = await snapshotDailyBrief({ projectDir: dir });
    expect(snap.markdown).toMatch(/Daily Brief/);
    expect(snap.markdown).toMatch(/Knowledge graph/);
  });

  it('uses a custom window description', async () => {
    const dir = await tmpDir();
    const snap = await snapshotDailyBrief({ projectDir: dir, windowDescription: 'evening recap' });
    expect(snap.markdown).toMatch(/evening recap/);
  });
});
