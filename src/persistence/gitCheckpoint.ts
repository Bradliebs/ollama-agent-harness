// Git checkpoints for runs — whole-workspace snapshots that also cover changes
// made outside the file tools (bash, scripts), which the side-effect ledger
// cannot see.
//
// A checkpoint is a commit of the working tree (tracked + untracked, honouring
// .gitignore) built through a temporary index and stored under
// refs/harness/runs/<runId>. The user's index, HEAD and branch are never
// touched. Restoring writes the checkpoint's files back and removes files that
// appeared after it, again through a temporary index.

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,160}$/;

async function git(projectDir: string, args: string[], indexFile?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: projectDir,
    env: { ...process.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

export function checkpointRef(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return `refs/harness/runs/${runId}`;
}

export async function isGitWorkTree(projectDir: string): Promise<boolean> {
  try {
    return (await git(projectDir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function withTempIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-git-index-'));
  try {
    return await fn(path.join(dir, 'index'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Snapshot the working tree for a run. Returns the commit id, or null outside a git repo. */
export async function createGitCheckpoint(projectDir: string, runId: string): Promise<string | null> {
  const ref = checkpointRef(runId);
  if (!(await isGitWorkTree(projectDir))) return null;
  return withTempIndex(async (indexFile) => {
    await git(projectDir, ['add', '-A', '--', '.'], indexFile);
    const tree = await git(projectDir, ['write-tree'], indexFile);
    let parent: string | null = null;
    try {
      parent = await git(projectDir, ['rev-parse', '--verify', '-q', 'HEAD']);
    } catch {
      parent = null;
    }
    const commit = await git(projectDir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `harness checkpoint ${runId}`]);
    await git(projectDir, ['update-ref', ref, commit]);
    return commit;
  });
}

export interface GitRestoreResult {
  commit: string;
  /** Files that appeared after the checkpoint and were removed. */
  removed: string[];
}

/** Return the working tree to a run's checkpoint. Throws when no checkpoint exists. */
export async function restoreGitCheckpoint(projectDir: string, runId: string): Promise<GitRestoreResult> {
  const ref = checkpointRef(runId);
  const commit = await git(projectDir, ['rev-parse', '--verify', ref]);
  return withTempIndex(async (indexFile) => {
    await git(projectDir, ['read-tree', commit], indexFile);
    // Anything the checkpoint does not know about (and .gitignore does not
    // exclude) was created after it.
    const untracked = await git(projectDir, ['ls-files', '--others', '--exclude-standard', '-z'], indexFile);
    const removed = untracked.split('\0').filter(Boolean);
    for (const relative of removed) {
      await fs.rm(path.join(projectDir, relative), { force: true });
    }
    await git(projectDir, ['checkout-index', '-a', '-f'], indexFile);
    return { commit, removed };
  });
}

export async function deleteGitCheckpoint(projectDir: string, runId: string): Promise<void> {
  await git(projectDir, ['update-ref', '-d', checkpointRef(runId)]);
}
