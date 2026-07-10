import { makeShellCommandRunner } from './shellRunner';
import type { Goal } from './types';

// Minimal Goal stub; the runner ignores it.
const goalStub = { id: 'g1', target: 't' } as unknown as Goal;

describe('goal/shellRunner', () => {
  it('returns success outcome on exit 0', async () => {
    const run = makeShellCommandRunner({ command: process.execPath, args: ['-e', 'process.stdout.write("ok"); process.exit(0)'] });
    const out = await run(goalStub, 1);
    expect(out.action).toMatch(/exited 0/);
    expect(out.notes).toContain('ok');
    expect(out.error).toBeUndefined();
  });

  it('returns failure outcome with exit code on non-zero exit', async () => {
    const run = makeShellCommandRunner({ command: process.execPath, args: ['-e', 'process.stderr.write("boom"); process.exit(7)'] });
    const out = await run(goalStub, 2);
    expect(out.action).toMatch(/exited 7/);
    expect(out.notes).toContain('[stderr] boom');
  });

  it('captures spawn failures (ENOENT) as iteration errors', async () => {
    const run = makeShellCommandRunner({ command: 'this-binary-definitely-does-not-exist-x9q2', args: [] });
    const out = await run(goalStub, 3);
    expect(out.error).toBe('ENOENT');
  });

  it('truncates large output', async () => {
    const script = 'for (let i = 0; i < 1000; i++) process.stdout.write("x".repeat(80) + "\\n"); process.exit(0)';
    const run = makeShellCommandRunner({ command: process.execPath, args: ['-e', script], maxOutputChars: 500 });
    const out = await run(goalStub, 4);
    expect(out.notes!.length).toBeLessThan(700); // 500 + truncation suffix
    expect(out.notes).toMatch(/truncated/);
  });

  it('honors per-iteration timeout', async () => {
    const run = makeShellCommandRunner({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 10000)'],
      timeoutMs: 200,
    });
    const out = await run(goalStub, 5);
    // execFile kills with SIGTERM on timeout; signal becomes the "code" field.
    expect(out.action).toMatch(/exited (SIGTERM|null|143)/);
  });
});
