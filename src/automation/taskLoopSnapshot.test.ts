/**
 * Coverage for the snapshot/restore exclusion contract in
 * cookbook/task-loop.ts.
 *
 * On a failed iteration the autonomy loop runs:
 *   git reset --hard <preIterationHead>
 *   git clean -fd -e '.forge-*'
 *
 * The `-e '.forge-*'` exclude is load-bearing — without it, every snapshot
 * restore would wipe `.forge-history.jsonl` (the lifetime task-outcome
 * archive) and `.forge-state.json` (the iteration checkpoint), erasing
 * the very memory the next iteration relies on for resume. This test
 * pins that invariant by reproducing the exact git command sequence
 * against a throwaway repo and asserting the forge files survive.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cookbook/task-loop snapshot restore preserves .forge-* files', () => {
  const originalCwd = process.cwd();
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'forge-snapshot-'));
    process.chdir(workDir);
    execSync('git init -q', { stdio: 'pipe' });
    execSync('git config user.email test@example.com', { stdio: 'pipe' });
    execSync('git config user.name test', { stdio: 'pipe' });
    writeFileSync(join(workDir, 'seed.txt'), 'seed');
    execSync('git add seed.txt', { stdio: 'pipe' });
    execSync('git commit -q -m seed', { stdio: 'pipe' });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('keeps .forge-history.jsonl across git reset --hard + git clean -fd -e .forge-*', () => {
    const historyPath = join(workDir, '.forge-history.jsonl');
    const statePath = join(workDir, '.forge-state.json');
    const strayPath = join(workDir, 'stray.txt');
    writeFileSync(historyPath, '{"task":"verify-x","status":"done"}\n');
    writeFileSync(statePath, '{"iteration":3}');
    writeFileSync(strayPath, 'model wrote this');

    const head = execSync('git rev-parse HEAD', { stdio: 'pipe' }).toString().trim();
    execSync(`git reset --hard ${head}`, { stdio: 'pipe' });
    execSync('git clean -fd -e .forge-*', { stdio: 'pipe' });

    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, 'utf-8')).toContain('verify-x');
    expect(existsSync(statePath)).toBe(true);
    expect(readFileSync(statePath, 'utf-8')).toContain('iteration');
    // Sanity check: untracked non-forge files ARE cleaned, so the exclude
    // is what kept the forge files alive (not a no-op clean).
    expect(existsSync(strayPath)).toBe(false);
  });
});
