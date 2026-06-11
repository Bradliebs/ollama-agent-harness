// Build gate: turn a set of files an agent just wrote into a concrete
// validation plan, then run it and report a single honest pass/fail.
//
// This is the missing "test" half of the chat path's test-and-learn loop.
// The decision (`planBuildGate`) is pure so it can be unit-tested without
// touching the filesystem or spawning processes; the caller supplies the
// gathered project facts (`ProjectProbe`) and an executor (`GateExec`).
//
// Pattern mirrors `cookbook/task-loop.ts` `decideRatchet`: a pure decision
// plus an injected side-effecting runner.

import * as path from 'path';

export type GateProjectKind = 'node' | 'python' | 'mixed' | 'none';

export interface GateCommand {
  /** Logical command. The runner resolves platform specifics (e.g. npm -> npm.cmd). */
  command: string;
  args: string[];
  cwd: string;
  /** Human label for events/logs, e.g. "typecheck", "py_compile", "import bioarn". */
  label: string;
}

export interface BuildGatePlan {
  kind: GateProjectKind;
  commands: GateCommand[];
  /** Why this plan was produced (or why it is empty). */
  reason: string;
}

/**
 * Filesystem facts about the working dir, gathered by the caller so the
 * planner stays pure and testable.
 */
export interface ProjectProbe {
  hasPackageJson: boolean;
  /** package.json "scripts" map (empty when absent). */
  packageScripts: Record<string, string>;
  /**
   * Importable top-level Python package names under the working dir (a
   * directory with `__init__.py` whose parent is the working dir). Running
   * `python -c "import <name>"` from the working dir catches the BioARN-class
   * failure where the package imports but its internal wiring is broken.
   */
  pythonPackages: string[];
  /**
   * True when the working dir has pytest-discoverable tests (a `tests/` dir or
   * `test_*.py` / `*_test.py` files). When set, the gate runs `pytest` so a
   * Python project is validated against its own tests, symmetric with how a
   * Node project's `test` script is run.
   */
  pythonHasTests?: boolean;
}

export interface PlanBuildGateInput {
  /** Paths of files the turn wrote or edited (absolute or workingDir-relative). */
  changedFiles: string[];
  /** Working directory the agent operated in (used as `cwd` for commands). */
  workingDir: string;
  probe: ProjectProbe;
  /** Cap on python files passed to a single py_compile invocation. */
  maxPyCompileFiles?: number;
}

export interface GateCommandResult {
  label: string;
  passed: boolean;
  exitCode: number;
  /** Truncated combined stdout/stderr for the event/log. */
  output: string;
}

export interface BuildGateResult {
  /** True only when at least one validation command was executed. */
  ran: boolean;
  /** True when it ran and every command passed. Vacuously true when not run. */
  passed: boolean;
  kind: GateProjectKind;
  results: GateCommandResult[];
  /** 1.0 = all passed, 0.0 = a command failed, undefined = did not run. */
  score: number | undefined;
  summary: string;
}

/** Side-effecting executor, injected so `runBuildGate` stays testable. */
export type GateExec = (cmd: GateCommand) => Promise<{ exitCode: number; output: string }>;

const NODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXT = new Set(['.py']);

function classifyChanged(changedFiles: string[]): { node: boolean; python: string[] } {
  let node = false;
  const python: string[] = [];
  for (const f of changedFiles) {
    const ext = path.extname(f).toLowerCase();
    if (NODE_EXT.has(ext)) node = true;
    else if (PY_EXT.has(ext)) python.push(f);
  }
  return { node, python };
}

/**
 * Decide what validation to run for a turn that changed files. Pure: no I/O.
 * Cheap, deterministic checks are ordered first; the runner stops at the first
 * failure so a broken import does not produce noisy downstream errors.
 */
export function planBuildGate(input: PlanBuildGateInput): BuildGatePlan {
  const { changedFiles, workingDir, probe } = input;
  const maxPy = input.maxPyCompileFiles ?? 25;

  if (changedFiles.length === 0) {
    return { kind: 'none', commands: [], reason: 'no files changed' };
  }

  const { node, python } = classifyChanged(changedFiles);
  const commands: GateCommand[] = [];

  // Python: py_compile (syntax) then import smoke (wiring).
  if (python.length > 0) {
    commands.push({
      command: 'python',
      args: ['-m', 'py_compile', ...python.slice(0, maxPy)],
      cwd: workingDir,
      label: 'py_compile',
    });
    for (const pkg of probe.pythonPackages) {
      commands.push({
        command: 'python',
        args: ['-c', `import ${pkg}`],
        cwd: workingDir,
        label: `import ${pkg}`,
      });
    }
    // Run the project's own tests last (slowest, most thorough). Only when the
    // project actually has tests, so we never fail a turn for missing tests.
    if (probe.pythonHasTests) {
      commands.push({ command: 'python', args: ['-m', 'pytest', '-q'], cwd: workingDir, label: 'pytest' });
    }
  }

  // Node: typecheck (fast, deterministic) or build, then test.
  if (node && probe.hasPackageJson) {
    const s = probe.packageScripts;
    if (s.typecheck) commands.push({ command: 'npm', args: ['run', 'typecheck'], cwd: workingDir, label: 'typecheck' });
    else if (s.build) commands.push({ command: 'npm', args: ['run', 'build'], cwd: workingDir, label: 'build' });
    if (s.test) commands.push({ command: 'npm', args: ['test'], cwd: workingDir, label: 'test' });
  }

  const kind: GateProjectKind = python.length > 0 && node ? 'mixed' : python.length > 0 ? 'python' : node ? 'node' : 'none';

  if (commands.length === 0) {
    const reason = node && !probe.hasPackageJson
      ? 'node files changed but no package.json with scripts'
      : 'no recognized validation for the changed files';
    return { kind, commands: [], reason };
  }

  return { kind, commands, reason: `validating ${changedFiles.length} changed file(s)` };
}

/**
 * Execute a plan via the injected executor. Stops at the first failing command.
 * Returns `ran: false` for an empty plan so callers can distinguish
 * "validation passed" from "nothing to validate".
 */
export async function runBuildGate(plan: BuildGatePlan, exec: GateExec): Promise<BuildGateResult> {
  if (plan.commands.length === 0) {
    return { ran: false, passed: true, kind: plan.kind, results: [], score: undefined, summary: plan.reason };
  }

  const results: GateCommandResult[] = [];
  let allPassed = true;
  for (const cmd of plan.commands) {
    const { exitCode, output } = await exec(cmd);
    const passed = exitCode === 0;
    results.push({ label: cmd.label, passed, exitCode, output });
    if (!passed) {
      allPassed = false;
      break;
    }
  }

  const failed = results.filter((r) => !r.passed);
  return {
    ran: true,
    passed: allPassed,
    kind: plan.kind,
    results,
    score: allPassed ? 1.0 : 0.0,
    summary: allPassed
      ? `validation passed (${results.map((r) => r.label).join(', ')})`
      : `validation FAILED: ${failed.map((r) => r.label).join(', ')}`,
  };
}

/** Readiness `verifier_score` contribution: the gate score, or undefined when it did not run. */
export function buildGateVerifierScore(result: BuildGateResult): number | undefined {
  return result.ran ? result.score : undefined;
}
