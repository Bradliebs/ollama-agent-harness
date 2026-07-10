// Goal iteration runner: spawn a shell command per iteration.
//
// The simplest useful runner. Drop-in for `runIteration` in src/goal/loop.ts.
// Wraps each iteration as a single command invocation and turns its exit
// code + stdout into a structured IterationOutcome. Suitable for goals
// where the agent's "work" is running a build / test / script that
// converges on success across multiple runs.

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { IterationOutcome } from './loop';
import type { Goal } from './types';

const execFileAsync = promisify(execFile);

export interface MakeShellCommandRunnerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-iteration timeout in ms. 0 / undefined = no timeout. */
  timeoutMs?: number;
  /** Cap captured stdout+stderr in the outcome. Defaults to 4 KiB. */
  maxOutputChars?: number;
}

export type IterationRunner = (goal: Goal, n: number) => Promise<IterationOutcome>;

export function makeShellCommandRunner(opts: MakeShellCommandRunnerOptions): IterationRunner {
  const cap = opts.maxOutputChars ?? 4_000;
  return async (_goal, n) => {
    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(opts.command, opts.args ?? [], {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined,
        maxBuffer: cap * 4,
      });
      const elapsed = Date.now() - started;
      return {
        action: `iter ${n}: \`${opts.command}\` exited 0 (${elapsed}ms)`,
        notes: truncate(stdout + (stderr ? `\n[stderr] ${stderr}` : ''), cap),
      };
    } catch (err) {
      const elapsed = Date.now() - started;
      // execFile rejects with an Error that carries .code, .signal, .stdout, .stderr.
      const e = err as NodeJS.ErrnoException & { code?: number | string; signal?: string; stdout?: string; stderr?: string };
      const exit = typeof e.code === 'number' ? e.code : (e.signal ?? 'unknown');
      const out = (e.stdout ?? '') + (e.stderr ? `\n[stderr] ${e.stderr}` : '');
      return {
        action: `iter ${n}: \`${opts.command}\` exited ${exit} (${elapsed}ms)`,
        notes: truncate(out || (e.message ?? ''), cap),
        // Treat hard spawn failures (ENOENT etc.) as iteration errors so the
        // loop records them distinctly from "ran and failed".
        error: typeof e.code === 'string' && e.code !== '' ? e.code : undefined,
      };
    }
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated ${s.length - max} chars)`;
}
