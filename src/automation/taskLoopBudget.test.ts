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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ralphLoop } from '../../cookbook/task-loop';

describe('cookbook/task-loop ralphLoop HARNESS_TIME_BUDGET_MS halt', () => {
  const originalCwd = process.cwd();
  const originalBudget = process.env.HARNESS_TIME_BUDGET_MS;
  const originalSnapshot = process.env.HARNESS_AUTONOMY_SNAPSHOT;
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
    if (originalSnapshot === undefined) delete process.env.HARNESS_AUTONOMY_SNAPSHOT;
    else process.env.HARNESS_AUTONOMY_SNAPSHOT = originalSnapshot;
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
});
