import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Test runs must never resolve a project dir inside the user's real
// workspace. A Jest run that inherited a user-level HARNESS_PROJECT_DIR once
// overwrote a live SOUL.md, settings.json grants, and model stats with test
// fixtures. Production callers are unaffected: the guard is a no-op outside
// test processes.

export function isTestProcess(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function isWithin(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Directories a test process may use as a project root. */
export function testSafeRoots(): string[] {
  // This file lives in src/persistence (ts-node/jest) or dist/persistence
  // (compiled), so two levels up is the harness checkout either way.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tmp = os.tmpdir();
  return Array.from(new Set([repoRoot, tmp, realpathOrSelf(tmp)]));
}

/**
 * Throw when a test process resolves a project dir outside the harness
 * checkout or the OS temp dir. Returns the dir unchanged otherwise.
 */
export function assertTestSafeProjectDir(dir: string): string {
  if (!isTestProcess()) return dir;
  const candidates = [dir, realpathOrSelf(dir)];
  const roots = testSafeRoots();
  const safe = candidates.some((candidate) => roots.some((root) => isWithin(candidate, root)));
  if (!safe) {
    throw new Error(
      `Refusing to use project dir "${dir}" from a test process: it is outside the harness checkout and the OS temp dir. `
      + 'Tests must use a temp dir or the repo-local .harness, never a real user workspace.',
    );
  }
  return dir;
}
