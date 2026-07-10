/**
 * End-to-end coverage for the snapshot-restore path in ralphLoop.
 *
 * Companion to taskLoopSnapshot.test.ts (which pins the raw git command).
 * This test exercises the actual ralphLoop failure branch with the
 * real snapshot-restore code running, asserting that:
 *   1. .forge-history.jsonl written by the failing iteration survives
 *   2. Stray untracked files written by the failing iteration are wiped
 *   3. The plan is re-marked as failed after `git reset` blows away the
 *      uncommitted plan edit
 *
 * This is the "would have caught the Windows single-quote bug" test —
 * the unit test pins the command, this one pins the full failure path.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ralphLoop } from '../../cookbook/task-loop';

describe('cookbook/task-loop ralphLoop snapshot restore E2E', () => {
  const originalCwd = process.cwd();
  const originalSnapshot = process.env.HARNESS_AUTONOMY_SNAPSHOT;
  let workDir: string;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'forge-restore-e2e-'));
    process.chdir(workDir);
    execSync('git init -q', { stdio: 'pipe' });
    execSync('git config user.email test@example.com', { stdio: 'pipe' });
    execSync('git config user.name test', { stdio: 'pipe' });
    writeFileSync(join(workDir, 'seed.txt'), 'seed');
    execSync('git add seed.txt', { stdio: 'pipe' });
    execSync('git commit -q -m seed', { stdio: 'pipe' });

    writeFileSync(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      ['# Plan', '', '- [ ] task-fail — will fail', ''].join('\n'),
    );
    // Commit the plan so `git reset --hard` restores it after the failed
    // iteration. Without this, the unrestored plan gets cleaned by the
    // very `git clean` we are testing.
    execSync('git add IMPLEMENTATION_PLAN.md', { stdio: 'pipe' });
    execSync('git commit -q -m plan', { stdio: 'pipe' });

    // Snapshot must be ON for this test — that is the path under test.
    delete process.env.HARNESS_AUTONOMY_SNAPSHOT;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    if (originalSnapshot === undefined) delete process.env.HARNESS_AUTONOMY_SNAPSHOT;
    else process.env.HARNESS_AUTONOMY_SNAPSHOT = originalSnapshot;
  });

  it('preserves .forge-history.jsonl and wipes stray files when an iteration fails', () => {
    // Three iterations exhaust the retry budget so the task transitions to
    // permanent [!]. Each iteration runs the same fail-then-restore cycle;
    // the assertions on history-preservation and stray-cleanup hold across
    // every attempt because snapshot restore runs on both retry and final
    // failure paths.
    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      3,
      false,
      {
        implementTask: () => {
          // Simulate a model that wrote real history (must survive) and a
          // stray untracked source file (must be cleaned).
          appendFileSync(
            join(workDir, '.forge-history.jsonl'),
            JSON.stringify({ task: 'task-fail', status: 'attempted' }) + '\n',
          );
          writeFileSync(join(workDir, 'stray-from-failed-task.txt'), 'should be cleaned');
        },
        validateTask: () => false,
      },
    );

    // Forge state survives the restore.
    const historyPath = join(workDir, '.forge-history.jsonl');
    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, 'utf-8')).toContain('task-fail');

    // Stray untracked file from the failed iteration is gone.
    expect(existsSync(join(workDir, 'stray-from-failed-task.txt'))).toBe(false);

    // Plan was re-marked failed after git reset (otherwise the next
    // iteration would pick the same task again).
    const finalPlan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    expect(finalPlan).toMatch(/^- \[!\] task-fail/m);
  });

  it('keeps a failed task visible when snapshot restore removes an uncommitted plan entry', () => {
    writeFileSync(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      ['# Plan', '', '- [x] already-done — committed task', ''].join('\n'),
    );
    execSync('git add IMPLEMENTATION_PLAN.md', { stdio: 'pipe' });
    execSync('git commit -q -m baseline-plan', { stdio: 'pipe' });
    writeFileSync(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      ['# Plan', '', '- [x] already-done — committed task', '- [ ] uncommitted-task — fails after being added later', ''].join('\n'),
    );

    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      3,
      false,
      {
        implementTask: () => {
          writeFileSync(join(workDir, 'stray-from-uncommitted-task.txt'), 'should be cleaned');
        },
        validateTask: () => false,
      },
    );

    expect(existsSync(join(workDir, 'stray-from-uncommitted-task.txt'))).toBe(false);
    const finalPlan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    expect(finalPlan).toMatch(/^- \[x\] already-done/m);
    expect(finalPlan).toMatch(/^- \[!\] uncommitted-task/m);
  });

  it('preserves sibling uncommitted pending tasks when one task fails and triggers snapshot restore', () => {
    // Reproduces the production bug: user added several new pending tasks
    // via plan-from-goal (uncommitted), the first one failed the evidence
    // gate, snapshot restore ran `git reset --hard` which wiped every
    // uncommitted plan entry, then the old restore code only re-added the
    // currently-failing task — silently deleting all sibling pending work
    // and causing the loop to exit "all tasks complete" prematurely.
    writeFileSync(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      ['# Plan', '', '- [x] already-done — committed task', ''].join('\n'),
    );
    execSync('git add IMPLEMENTATION_PLAN.md', { stdio: 'pipe' });
    execSync('git commit -q -m baseline-plan', { stdio: 'pipe' });
    writeFileSync(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      [
        '# Plan',
        '',
        '- [x] already-done — committed task',
        '- [ ] task-a — will fail and trigger restore',
        '- [ ] task-b — sibling, must survive restore',
        '- [ ] task-c — sibling, must also survive restore',
        '',
      ].join('\n'),
    );

    // Only one iteration: the first task fails and triggers restore.
    // After restore, the plan must still list task-b and task-c as pending.
    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      1,
      false,
      {
        implementTask: () => {
          writeFileSync(join(workDir, 'stray.txt'), 'wipe me');
        },
        validateTask: () => false,
      },
    );

    const finalPlan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    expect(finalPlan).toMatch(/^- \[x\] already-done/m);
    expect(finalPlan).toMatch(/^- \[ \] task-b/m);
    expect(finalPlan).toMatch(/^- \[ \] task-c/m);
    // task-a was the failing one; with retry budget > 0 it stays pending,
    // with budget exhausted it would be [!]. Either way it must still
    // appear — it must not have been silently deleted.
    expect(finalPlan).toMatch(/^- \[[ !]\] task-a/m);
  });
});
