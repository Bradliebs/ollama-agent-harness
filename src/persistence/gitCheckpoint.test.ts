import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGitCheckpoint, deleteGitCheckpoint, isGitWorkTree, restoreGitCheckpoint } from './gitCheckpoint';

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

describe('git checkpoints', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-git-checkpoint-'));
    git(dir, ['init', '--quiet']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'v1\n');
    await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.log\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', 'init']);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('snapshots the working tree without touching HEAD or the index, then restores it', async () => {
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'v2 uncommitted\n');
    await fs.writeFile(path.join(dir, 'notes.md'), 'untracked before run\n');
    const headBefore = git(dir, ['rev-parse', 'HEAD']);
    const statusBefore = git(dir, ['status', '--porcelain']);

    const commit = await createGitCheckpoint(dir, 'run-ckpt-1');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(dir, ['status', '--porcelain'])).toBe(statusBefore);

    // The "run" changes things, including via a shell (not the file tools).
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'v3 from bash\n');
    await fs.rm(path.join(dir, 'notes.md'));
    await fs.writeFile(path.join(dir, 'created-by-run.txt'), 'new\n');
    await fs.writeFile(path.join(dir, 'ignored.log'), 'log\n');

    const result = await restoreGitCheckpoint(dir, 'run-ckpt-1');
    expect(result.removed).toEqual(['created-by-run.txt']);
    expect(await fs.readFile(path.join(dir, 'tracked.txt'), 'utf-8')).toBe('v2 uncommitted\n');
    expect(await fs.readFile(path.join(dir, 'notes.md'), 'utf-8')).toBe('untracked before run\n');
    await expect(fs.access(path.join(dir, 'created-by-run.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'ignored.log'), 'utf-8')).toBe('log\n');
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(dir, ['status', '--porcelain'])).toBe(statusBefore);

    await deleteGitCheckpoint(dir, 'run-ckpt-1');
    await expect(restoreGitCheckpoint(dir, 'run-ckpt-1')).rejects.toThrow();
  });

  it('returns null outside a git repository and rejects unsafe run ids', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-no-git-'));
    try {
      expect(await isGitWorkTree(plain)).toBe(false);
      expect(await createGitCheckpoint(plain, 'run-x')).toBeNull();
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
    await expect(createGitCheckpoint(dir, '../bad')).rejects.toThrow(/Invalid run id/);
  });
});
