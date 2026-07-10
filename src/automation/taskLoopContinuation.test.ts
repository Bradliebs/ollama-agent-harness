/**
 * Coverage for the Phase 4 cross-loop continuation seam wired into
 * cookbook/task-loop.ts ralphLoop.
 *
 * The seam is DEFAULT OFF. When HARNESS_CONTINUATION=1, a non-clean halt
 * with remaining work writes a bounded continuation request under
 * .harness/continuation instead of silently stranding the leftover tasks.
 * This test drives the time-budget halt (deterministic, sub-second) and
 * asserts:
 *   - default off  => NO request marker (behaviour unchanged),
 *   - flag on       => a request marker queues the remaining tasks,
 *   - meta-budget   => exhausted lineage stops requesting.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ralphLoop } from '../../cookbook/task-loop';

const REQUEST_PATH = join('.harness', 'continuation', 'request.json');
const STATE_PATH = join('.harness', 'continuation', 'state.json');

describe('cookbook/task-loop ralphLoop continuation seam', () => {
  const originalCwd = process.cwd();
  const saved: Record<string, string | undefined> = {};
  let workDir: string;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  function snapshotEnv(...keys: string[]): void {
    for (const k of keys) saved[k] = process.env[k];
  }
  function restoreEnv(): void {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    snapshotEnv(
      'HARNESS_TIME_BUDGET_MS',
      'HARNESS_AUTONOMY_SNAPSHOT',
      'HARNESS_CONTINUATION',
      'HARNESS_MAX_CONTINUATIONS',
      'FORGE_REQUESTED_ITERATIONS',
      'HARNESS_BRACKNELL_DIR',
    );
    workDir = mkdtempSync(join(tmpdir(), 'forge-cont-'));
    process.chdir(workDir);
    execSync('git init -q', { stdio: 'pipe' });
    execSync('git config user.email test@example.com', { stdio: 'pipe' });
    execSync('git config user.name test', { stdio: 'pipe' });
    writeFileSync(join(workDir, 'seed.txt'), 'seed');
    execSync('git add seed.txt', { stdio: 'pipe' });
    execSync('git commit -q -m seed', { stdio: 'pipe' });

    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), [
      '# Plan',
      '',
      '- [ ] task-a — first',
      '- [ ] task-b — second',
      '- [ ] task-c — third',
      '',
    ].join('\n'));

    process.env.HARNESS_TIME_BUDGET_MS = '1';
    process.env.HARNESS_AUTONOMY_SNAPSHOT = '0';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    restoreEnv();
  });

  const hooks = {
    implementTask: () => {
      const until = Date.now() + 5;
      while (Date.now() < until) { /* burn wall-clock to trip the budget */ }
    },
    validateTask: () => true,
  };

  it('does NOT write a continuation request when the flag is off (default behaviour)', () => {
    delete process.env.HARNESS_CONTINUATION;
    ralphLoop(join(workDir, 'IMPLEMENTATION_PLAN.md'), 10, false, hooks);
    expect(existsSync(join(workDir, REQUEST_PATH))).toBe(false);
    expect(existsSync(join(workDir, STATE_PATH))).toBe(false);
  });

  it('writes a bounded continuation request queuing the remaining tasks when the flag is on', () => {
    process.env.HARNESS_CONTINUATION = '1';
    process.env.HARNESS_MAX_CONTINUATIONS = '2';
    ralphLoop(join(workDir, 'IMPLEMENTATION_PLAN.md'), 10, false, hooks);

    expect(existsSync(join(workDir, REQUEST_PATH))).toBe(true);
    const request = JSON.parse(readFileSync(join(workDir, REQUEST_PATH), 'utf8'));
    expect(request.endReason).toBe('time-budget-exhausted');
    expect(request.continuationsUsed).toBe(1);
    expect(request.maxContinuations).toBe(2);
    // Some tasks remained unfinished and are queued for the follow-on loop.
    expect(request.followOnTasks.length).toBeGreaterThan(0);
    expect(request.followOnTasks.every((t: { status: string }) => t.status === 'pending')).toBe(true);

    const state = JSON.parse(readFileSync(join(workDir, STATE_PATH), 'utf8'));
    expect(state.continuationsUsed).toBe(1);
  });

  it('stops requesting once the meta-budget is exhausted', () => {
    process.env.HARNESS_CONTINUATION = '1';
    process.env.HARNESS_MAX_CONTINUATIONS = '0';
    ralphLoop(join(workDir, 'IMPLEMENTATION_PLAN.md'), 10, false, hooks);
    // maxContinuations=0 disables continuation: no request, no state increment.
    expect(existsSync(join(workDir, REQUEST_PATH))).toBe(false);
  });

  it('resets a permanently-failed task back to pending in the plan so a follow-on loop can resume', () => {
    process.env.HARNESS_CONTINUATION = '1';
    process.env.HARNESS_MAX_CONTINUATIONS = '2';
    process.env.HARNESS_TIME_BUDGET_MS = '0'; // disable budget; reach the blocked path
    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), [
      '# Plan',
      '',
      '- [ ] task-a — will fail with no output',
      '- [ ] task-b — should never run',
      '',
    ].join('\n'));

    ralphLoop(join(workDir, 'IMPLEMENTATION_PLAN.md'), 6, false, {
      // task-a writes nothing => reverts every attempt => fails after the
      // retry budget, halting on blocked-by-failed-prerequisite.
      implementTask: (task) => {
        if (task.id === 'task-b') writeFileSync(join(workDir, 'b.txt'), 'b');
      },
      validateTask: () => true,
    });

    // The plan was rewritten with the failed task reset to pending so a fresh
    // bounded loop will retry it instead of re-halting on the same block.
    const plan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf8');
    expect(plan).toContain('- [ ] task-a');
    expect(plan).not.toContain('- [!] task-a');
    expect(plan).toContain('- [ ] task-b');

    const request = JSON.parse(readFileSync(join(workDir, REQUEST_PATH), 'utf8'));
    expect(request.endReason).toBe('blocked-by-failed-prerequisite');
    expect(request.followOnTasks.map((t: { id: string }) => t.id)).toContain('task-a');
    expect(request.followOnTasks.every((t: { status: string }) => t.status === 'pending')).toBe(true);
  });
});
