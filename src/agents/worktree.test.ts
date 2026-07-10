import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSubagentWorktree } from './worktree';

function gitInit(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const seed = path.join(dir, 'seed.txt');
    fs.writeFileSync(seed, 'hello\n');
    const run = (args: string[]) => new Promise<void>((res, rej) => {
      const cp = spawn('git', args, { cwd: dir, stdio: 'ignore' });
      cp.on('error', rej);
      cp.on('close', (code) => code === 0 ? res() : rej(new Error(`git ${args.join(' ')} -> ${code}`)));
    });
    (async () => {
      await run(['init', '-q']);
      await run(['config', 'user.email', 'wt-test@example.com']);
      await run(['config', 'user.name', 'wt-test']);
      await run(['add', '.']);
      await run(['commit', '-q', '-m', 'seed']);
      resolve();
    })().catch(reject);
  });
}

function gitAvailable(): boolean {
  try {
    const cp = require('child_process').spawnSync('git', ['--version'], { stdio: 'ignore' });
    return cp.status === 0;
  } catch { return false; }
}

const itGit = gitAvailable() ? it : it.skip;

describe('createSubagentWorktree', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-base-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns not-a-repo when baseDir has no .git', async () => {
    const r = await createSubagentWorktree({ baseDir: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-a-repo');
  });

  it('returns no-git when the git binary is missing', async () => {
    fs.writeFileSync(path.join(tmp, 'seed.txt'), 'x');
    // Force a "repo" look-alike so we get past the cheap check.
    fs.mkdirSync(path.join(tmp, '.git'));
    const r = await createSubagentWorktree({ baseDir: tmp, gitBin: '__definitely_not_git_xyz__' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // On Windows the spawn ENOENT message wording differs; we just need
      // the failure to land in the no-git/not-a-repo branch.
      expect(['no-git', 'not-a-repo']).toContain(r.reason);
    }
  });

  itGit('roundtrip: creates a detached worktree at HEAD and cleans up', async () => {
    await gitInit(tmp);
    const r = await createSubagentWorktree({ baseDir: tmp, branchHint: 'explore!' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    try {
      expect(fs.existsSync(r.path)).toBe(true);
      // Seed file from the base repo should be checked out.
      expect(fs.existsSync(path.join(r.path, 'seed.txt'))).toBe(true);
      expect(r.head).toMatch(/^[0-9a-f]{40}/);
      // Branch hint should be sanitised into the path (no '!').
      expect(r.path.includes('explore')).toBe(true);
      expect(r.path.includes('!')).toBe(false);
    } finally {
      await r.cleanup();
    }
    expect(fs.existsSync(r.path)).toBe(false);
  });

  itGit('cleanup is idempotent', async () => {
    await gitInit(tmp);
    const r = await createSubagentWorktree({ baseDir: tmp });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.cleanup();
    await expect(r.cleanup()).resolves.toBeUndefined();
  });

  itGit('two concurrent worktrees do not collide', async () => {
    await gitInit(tmp);
    const [a, b] = await Promise.all([
      createSubagentWorktree({ baseDir: tmp, branchHint: 'a' }),
      createSubagentWorktree({ baseDir: tmp, branchHint: 'b' }),
    ]);
    try {
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.path).not.toBe(b.path);
      expect(fs.existsSync(a.path)).toBe(true);
      expect(fs.existsSync(b.path)).toBe(true);
    } finally {
      if (a.ok) await a.cleanup();
      if (b.ok) await b.cleanup();
    }
  });
});
