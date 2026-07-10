// Git-worktree helper. Borrowed from war_loops as the cleanest pattern
// for isolating parallel work without cloning the whole repo.
//
// Scope is intentionally narrow: a function that creates a detached
// worktree at a temp path and returns a disposer that removes it. It
// does NOT (yet) wire itself into subagent dispatch, because today's
// tool surface does not take a per-call cwd — wiring without a cwd
// injection point would be isolation theatre. Callers that have an
// authentic injection point (recipes, custom runners) can opt in.
//
// All operations defensive: if `git` is missing, not a repo, or worktree
// add/remove fails, the helper returns a clear { ok: false, reason }
// rather than throwing across an unrelated stack frame.

import { spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CreateSubagentWorktreeOptions {
  /** Repo root whose worktree we are adding to. Must contain .git. */
  baseDir: string;
  /** Short hint folded into the worktree directory name + branch label. */
  branchHint?: string;
  /** Override temp root for the worktree path. Defaults to os.tmpdir(). */
  tmpRoot?: string;
  /** Override the git binary. Defaults to 'git'. */
  gitBin?: string;
}

export interface SubagentWorktreeHandle {
  ok: true;
  /** Absolute path to the created worktree directory. */
  path: string;
  /** Detached commit HEAD at creation time. */
  head: string;
  /** Remove the worktree and free its registration. Idempotent. */
  cleanup: () => Promise<void>;
}

export interface SubagentWorktreeFailure {
  ok: false;
  /** Stable enum for callers that want to branch on the failure mode. */
  reason: 'no-git' | 'not-a-repo' | 'worktree-add-failed';
  /** Human-readable detail; always present. */
  detail: string;
}

export type SubagentWorktreeResult = SubagentWorktreeHandle | SubagentWorktreeFailure;

export async function createSubagentWorktree(
  opts: CreateSubagentWorktreeOptions,
): Promise<SubagentWorktreeResult> {
  const baseDir = path.resolve(opts.baseDir);
  const gitBin = opts.gitBin ?? 'git';
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();

  // Cheapest check first: is this even a git repo?
  if (!isLikelyGitRepo(baseDir)) {
    return { ok: false, reason: 'not-a-repo', detail: `${baseDir} is not a git repository (no .git found)` };
  }

  // Confirm git binary is invokable. We resolve HEAD as a side-product so
  // the caller knows what commit the worktree was anchored to.
  const headRes = await runGit(gitBin, ['rev-parse', 'HEAD'], { cwd: baseDir });
  if (!headRes.ok) {
    const isMissing = /ENOENT|not found|cannot find|spawn .* ENOENT/i.test(headRes.detail);
    return {
      ok: false,
      reason: isMissing ? 'no-git' : 'not-a-repo',
      detail: headRes.detail,
    };
  }
  const head = headRes.stdout.trim();

  const safeHint = sanitizeHint(opts.branchHint);
  const wtDir = await fs.promises.mkdtemp(path.join(tmpRoot, `harness-wt-${safeHint}-`));
  // `git worktree add` requires the path to NOT pre-exist (mkdtemp creates
  // it). Remove the empty dir so the add succeeds atomically.
  await fs.promises.rm(wtDir, { recursive: true, force: true });

  const addRes = await runGit(gitBin, ['worktree', 'add', '--detach', wtDir, head], { cwd: baseDir });
  if (!addRes.ok) {
    return { ok: false, reason: 'worktree-add-failed', detail: addRes.detail };
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    // Force removal: worktree may contain uncommitted edits we genuinely
    // want to discard (it was a scratch space). Failures here are logged
    // up to the caller via stderr; we still try fs removal as a backstop.
    await runGit(gitBin, ['worktree', 'remove', '--force', wtDir], { cwd: baseDir });
    await fs.promises.rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return { ok: true, path: wtDir, head, cleanup };
}

function isLikelyGitRepo(dir: string): boolean {
  try {
    const gitPath = path.join(dir, '.git');
    const stat = fs.statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function sanitizeHint(hint: string | undefined): string {
  if (!hint) return 'sub';
  const cleaned = hint.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
  return cleaned.length > 0 ? cleaned : 'sub';
}

interface RunGitResult { ok: boolean; stdout: string; stderr: string; detail: string; }

function runGit(bin: string, args: string[], spawnOpts: SpawnOptions): Promise<RunGitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: '', detail: `spawn ${bin}: ${(err as Error).message}` });
      return;
    }
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf-8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf-8'); });
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr, detail: `${bin} error: ${err.message}` });
    });
    child.on('close', (code) => {
      const ok = code === 0;
      const detail = ok
        ? ''
        : `git ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`;
      resolve({ ok, stdout, stderr, detail });
    });
  });
}
