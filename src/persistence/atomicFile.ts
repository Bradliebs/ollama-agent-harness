// ─── Atomic file write + in-process file lock ──────────────────────────
//
// Two primitives that together close the read-modify-write race class
// the system audit flagged on .harness/automations.json and friends.
// Both are pure-stdlib; no new dependencies.
//
// Threat model: single Node process. Two async paths (e.g. the automation
// scheduler's tick and a UI route handler) can interleave their
// read-mutate-write of the same JSON file and lose data.
//
// Out of scope: cross-process locking. The harness assumes a single
// server process; if that ever changes, swap `withFileLock` for a
// real flock-style implementation (or `proper-lockfile`).

import { promises as fs } from 'fs';
import * as path from 'path';

// ─── In-process mutex per file path ─────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();

/**
 * Serialize async work on a file path within this process. Returns the
 * result of `fn`. While `fn` is in flight, any other call with the same
 * absolute path queues and runs after `fn` settles.
 *
 * The internal Promise chain always resolves (never rejects), so one
 * caller's failure does NOT poison subsequent callers. The original
 * rejection is rethrown to the failing caller only.
 *
 * Memory: one Promise reference per unique path that's ever been locked.
 * Bounded by the number of distinct files the harness uses — small.
 *
 * Caller MUST pass an absolute path. Relative paths can alias across
 * cwd changes and break the contract.
 */
export async function withFileLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(`withFileLock requires an absolute path, got: ${absolutePath}`);
  }
  const prev = (chains.get(absolutePath) ?? Promise.resolve()) as Promise<unknown>;
  // The step we put back into the chain must NEVER reject so subsequent
  // waiters proceed. Capture the outcome separately and re-throw to the
  // current caller after awaiting our own step.
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  let outcome!: Outcome;
  const step = prev.then(async () => {
    try {
      outcome = { ok: true, value: await fn() };
    } catch (error) {
      outcome = { ok: false, error };
    }
  });
  chains.set(absolutePath, step);
  await step;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

// ─── Atomic write ───────────────────────────────────────────────────────

const RENAME_RETRY_DELAYS_MS = [25, 75, 150, 300, 600];

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  /** File mode (e.g. 0o600 for secret-bearing files). */
  mode?: number;
}

/**
 * Crash-safe write: writes to a unique sibling temp file then renames
 * over the destination. The temp file lives in the same directory so
 * `rename` is atomic on POSIX and atomic-ish on Windows (with retry on
 * the transient EPERM/EBUSY/EACCES that the OS surfaces when antivirus
 * or another reader briefly holds the destination).
 *
 * On rename failure the temp file is cleaned up best-effort so the
 * directory does not accumulate orphan `.tmp.*` files.
 */
export async function atomicWriteFile(
  absolutePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(`atomicWriteFile requires an absolute path, got: ${absolutePath}`);
  }
  const dir = path.dirname(absolutePath);
  const base = path.basename(absolutePath);
  await fs.mkdir(dir, { recursive: true });
  // Suffix includes pid + random to avoid collision when multiple
  // processes accidentally share a target (shouldn't happen, but
  // cheap insurance).
  const suffix = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = path.join(dir, `.${base}.tmp.${suffix}`);
  await fs.writeFile(tmpPath, data, { encoding: options.encoding ?? 'utf-8', mode: options.mode });
  try {
    await renameWithRetry(tmpPath, absolutePath);
  } catch (error) {
    // Clean up the orphan temp on rename failure. Best-effort.
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

async function renameWithRetry(tmpPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (error) {
      if (!isTransientWindowsRenameError(error) || attempt === RENAME_RETRY_DELAYS_MS.length) throw error;
      await delay(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-only: clear the lock chain map. Do not use in production code. */
export function _resetFileLocksForTest(): void {
  chains.clear();
}
