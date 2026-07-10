/**
 * Coverage for the HARNESS_TIME_BUDGET_MS hard-stop in
 * cookbook/task-loop.ts.
 *
 * The wall-clock budget cap is the last line of defense against an
 * overnight autonomy run burning unbounded paid-backend tokens. The
 * check fires at the top of each iteration; once `Date.now() - startTime`
 * exceeds the configured budget, the loop writes a "time budget
 * exhausted" health summary and exits — even if pending tasks remain
 * and `maxIterations` has not been reached.
 *
 * This test injects a fast no-op implementTask + always-true validateTask
 * so the real harness CLI and npm typecheck never run, keeping the test
 * deterministic and sub-second.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ralphLoop } from '../../cookbook/task-loop';

describe('cookbook/task-loop ralphLoop HARNESS_TIME_BUDGET_MS halt', () => {
  const originalCwd = process.cwd();
  const originalBudget = process.env.HARNESS_TIME_BUDGET_MS;
  const originalRequestedIterations = process.env.FORGE_REQUESTED_ITERATIONS;
  const originalSnapshot = process.env.HARNESS_AUTONOMY_SNAPSHOT;
  const originalBracknellDir = process.env.HARNESS_BRACKNELL_DIR;
  let workDir: string;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'forge-budget-'));
    process.chdir(workDir);
    execSync('git init -q', { stdio: 'pipe' });
    execSync('git config user.email test@example.com', { stdio: 'pipe' });
    execSync('git config user.name test', { stdio: 'pipe' });
    writeFileSync(join(workDir, 'seed.txt'), 'seed');
    execSync('git add seed.txt', { stdio: 'pipe' });
    execSync('git commit -q -m seed', { stdio: 'pipe' });

    // A plan with several pending tasks so the loop would otherwise keep
    // running well past the budget cap.
    const plan = [
      '# Plan',
      '',
      '- [ ] task-a — first',
      '- [ ] task-b — second',
      '- [ ] task-c — third',
      '',
    ].join('\n');
    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), plan);

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
    if (originalBudget === undefined) delete process.env.HARNESS_TIME_BUDGET_MS;
    else process.env.HARNESS_TIME_BUDGET_MS = originalBudget;
    if (originalRequestedIterations === undefined) delete process.env.FORGE_REQUESTED_ITERATIONS;
    else process.env.FORGE_REQUESTED_ITERATIONS = originalRequestedIterations;
    if (originalSnapshot === undefined) delete process.env.HARNESS_AUTONOMY_SNAPSHOT;
    else process.env.HARNESS_AUTONOMY_SNAPSHOT = originalSnapshot;
    if (originalBracknellDir === undefined) delete process.env.HARNESS_BRACKNELL_DIR;
    else process.env.HARNESS_BRACKNELL_DIR = originalBracknellDir;
  });

  it('halts with "time budget exhausted" reason when HARNESS_TIME_BUDGET_MS is exceeded', () => {
    const implementCalls: string[] = [];
    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      10,
      false,
      {
        implementTask: (task) => {
          implementCalls.push(task.id);
          // Burn enough wall-clock to guarantee iter 2's budget check fires.
          const until = Date.now() + 5;
          while (Date.now() < until) { /* spin */ }
        },
        validateTask: () => true,
      },
    );

    const warned = warnSpy.mock.calls.flat().join('\n');
    const logged = logSpy.mock.calls.flat().join('\n');
    expect(warned).toMatch(/Time budget exhausted/);
    expect(logged).toMatch(/Reason:\s+time budget exhausted/);
    // Loop must have stopped before all 3 plan tasks were attempted.
    expect(implementCalls.length).toBeLessThan(3);
  });

  it('halts on a permanently failed prerequisite instead of running downstream tasks', () => {
    // Sequential plans build on each other. If the first not-done task has
    // failed after exhausting its retry budget, the loop must NOT skip ahead
    // to later tasks (which would build on a missing scaffold) — it halts.
    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), [
      '# Plan',
      '',
      '- [ ] task-a — will fail with no output',
      '- [ ] task-b — should never run',
      '',
    ].join('\n'));
    rmSync(join(workDir, '.forge-state.json'), { force: true });
    process.env.HARNESS_TIME_BUDGET_MS = '0';

    const implementCalls: string[] = [];
    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      6,
      false,
      {
        // task-a writes nothing → reverts every attempt → fails after the
        // retry budget. task-b would write a file, but the dependency gate
        // must stop it from ever running.
        implementTask: (task) => {
          implementCalls.push(task.id);
          if (task.id === 'task-b') writeFileSync(join(workDir, 'b.txt'), 'b');
        },
        validateTask: () => true,
      },
    );

    // task-a tried exactly TASK_RETRY_BUDGET (3) times; task-b never reached.
    expect(implementCalls).toEqual(['task-a', 'task-a', 'task-a']);
    expect(implementCalls).not.toContain('task-b');

    const plan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    expect(plan).toContain('- [!] task-a');
    expect(plan).toContain('- [ ] task-b');

    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/Blocked:.*task-a/);
  });

  it('logs requested task budget separately from absolute resume iteration stop', () => {
    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), ['# Plan', '', '- [ ] task-a — first', ''].join('\n'));
    writeFileSync(join(workDir, '.forge-state.json'), JSON.stringify({ iteration: 1, lastTaskId: 'previous-task' }));
    process.env.HARNESS_TIME_BUDGET_MS = '0';
    process.env.FORGE_REQUESTED_ITERATIONS = '20';

    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      21,
      false,
      {
        implementTask: () => {
          writeFileSync(join(workDir, 'changed.txt'), 'changed');
        },
        validateTask: () => true,
      },
    );

    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/Run budget: 20 requested task\(s\); checkpoint iteration 1; absolute stop iteration 21\./);
    expect(logged).toMatch(/=== Iteration 2\/21 ===/);
  });

  it('allows Bracknell delivery tasks to validate through external output files', () => {
    const bracknellDir = join(workDir, 'Bracknell_Food_Business');
    mkdirSync(bracknellDir, { recursive: true });
    process.env.HARNESS_BRACKNELL_DIR = bracknellDir;
    process.env.HARNESS_TIME_BUDGET_MS = '0';

    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), [
      '# Plan',
      '',
      '- [ ] finish-bracknell-food-business-delivery — Finish the Bracknell food business delivery.',
      '',
    ].join('\n'));

    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      1,
      false,
      {
        implementTask: () => {
          writeFileSync(join(bracknellDir, 'OUTPUT_MANIFEST.md'), 'Changed today. email_draft created.');
          writeFileSync(join(bracknellDir, 'READ_ME_FIRST.md'), 'Read this first.');
          writeFileSync(join(bracknellDir, 'EMAIL_DRAFT.md'), 'Draft email.');
        },
      },
    );

    const plan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    expect(plan).toContain('- [x] finish-bracknell-food-business-delivery');
  });

  it('requires an HTML visual report for visual Bracknell delivery tasks', () => {
    const bracknellDir = join(workDir, 'Bracknell_Food_Business');
    mkdirSync(bracknellDir, { recursive: true });
    process.env.HARNESS_BRACKNELL_DIR = bracknellDir;
    process.env.HARNESS_TIME_BUDGET_MS = '0';

    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), [
      '# Plan',
      '',
      '- [ ] bracknell-visual-report — Create a visually appealing Bracknell food business final report. Do not use markdown files as the final report.',
      '',
    ].join('\n'));
    rmSync(join(workDir, '.forge-state.json'), { force: true });

    // Three iterations exhaust the retry budget (TASK_RETRY_BUDGET = 3) so
    // the failing task flips from `[ ]` (retry pending) to `[!]` (permanent).
    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      3,
      false,
      {
        implementTask: () => {
          writeFileSync(join(bracknellDir, 'OUTPUT_MANIFEST.md'), 'Changed today. email_draft created.');
          writeFileSync(join(bracknellDir, 'READ_ME_FIRST.md'), 'Read this first.');
          writeFileSync(join(bracknellDir, 'EMAIL_DRAFT.md'), 'Draft email.');
        },
      },
    );

    let plan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    expect(plan).toContain('- [!] bracknell-visual-report');

    writeFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), [
      '# Plan',
      '',
      '- [ ] bracknell-visual-report — Create a visually appealing Bracknell food business final report. Do not use markdown files as the final report.',
      '',
    ].join('\n'));
    rmSync(join(workDir, '.forge-state.json'), { force: true });

    ralphLoop(
      join(workDir, 'IMPLEMENTATION_PLAN.md'),
      1,
      false,
      {
        implementTask: () => {
          writeFileSync(join(bracknellDir, 'OUTPUT_MANIFEST.md'), 'Changed today. email_draft created.');
          writeFileSync(join(bracknellDir, 'READ_ME_FIRST.md'), 'Read this first.');
          writeFileSync(join(bracknellDir, 'EMAIL_DRAFT.md'), 'Draft email.');
          writeFileSync(join(bracknellDir, 'ROBYN_VISUAL_REPORT.html'), '<!doctype html><title>Report</title>');
        },
      },
    );

    plan = readFileSync(join(workDir, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    expect(plan).toContain('- [x] bracknell-visual-report');
  });
});
