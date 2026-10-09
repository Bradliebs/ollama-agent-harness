// Done-State Verifier — validates that work products meet their completion criteria.
//
// For code: runs typecheck, lint, tests (if available).
// For services: checks state exists, commands work, schedule exists, promise recorded.
// For general tasks: checks that outputs match the request intent.

import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stripAnsiCodes } from '../context/toolOutputCompaction';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────

export type VerificationDomain = 'code' | 'service' | 'task' | 'promise';

export type VerificationStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface VerificationCheck {
  name: string;
  domain: VerificationDomain;
  status: VerificationStatus;
  detail?: string;
  duration_ms?: number;
}

export interface VerificationResult {
  domain: VerificationDomain;
  overall: VerificationStatus;
  checks: VerificationCheck[];
  timestamp: string;
}

// ─── Code verification ──────────────────────────────────────────────

interface CodeVerifyOptions {
  projectDir: string;
  /** Specific files that were changed (for targeted test runs). */
  changedFiles?: string[];
  /** Skip slow checks. */
  quick?: boolean;
  /** Timeout per check in ms. */
  timeout?: number;
  /** Cancels running checks (e.g. the user stopped the run). */
  signal?: AbortSignal;
}

interface CommandRun {
  ok: boolean;
  output: string;
  duration_ms: number;
  /** True when the command could not finish on its own: timeout, output over the buffer limit, or cancellation. */
  timedOut: boolean;
  /** True when the executable itself was not found. */
  missing: boolean;
}

/** Characters of failing output kept for the model; the end of a log holds the errors and the summary. */
const FAILURE_DETAIL_MAX_CHARS = 3_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

async function runCommand(cwd: string, cmd: string, args: string[], timeout = 60_000, signal?: AbortSignal): Promise<CommandRun> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: COMMAND_MAX_BUFFER, ...(signal ? { signal } : {}) });
    return { ok: true, output: (stdout + '\n' + stderr).trim(), duration_ms: Date.now() - start, timedOut: false, missing: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; code?: string | number; name?: string };
    // execFile sets killed=true when it terminates the child (timeout or maxBuffer).
    const interrupted = e.killed === true || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e.name === 'AbortError';
    const output = [e.stdout ?? '', e.stderr ?? '', e.message ?? ''].filter((part) => part.trim()).join('\n');
    return { ok: false, output, duration_ms: Date.now() - start, timedOut: interrupted, missing: e.code === 'ENOENT' };
  }
}

// A check that could not run or finish means "could not verify", not
// "verification failed": a missing tool is skip and a timeout is warn, so
// default-on verification never fails a run on its own account.
function checkStatus(r: CommandRun): VerificationStatus {
  if (r.ok) return 'pass';
  if (r.missing) return 'skip';
  return r.timedOut ? 'warn' : 'fail';
}

function checkDetail(r: CommandRun, cmd: string): string | undefined {
  if (r.ok) return undefined;
  if (r.missing) return `${cmd} is not installed or not on PATH`;
  if (r.timedOut) return 'Did not finish (timed out, cancelled, or output too large) \u2014 could not verify within budget';
  const text = stripAnsiCodes(r.output).trim();
  return text.length > FAILURE_DETAIL_MAX_CHARS ? `...${text.slice(-FAILURE_DETAIL_MAX_CHARS)}` : text;
}

function commandCheck(name: string, cmd: string, r: CommandRun): VerificationCheck {
  return { name, domain: 'code', status: checkStatus(r), detail: checkDetail(r, cmd), duration_ms: r.duration_ms };
}

export async function verifyCode(options: CodeVerifyOptions): Promise<VerificationResult> {
  const { projectDir, quick = false, timeout = 60_000, signal } = options;
  const checks: VerificationCheck[] = [];

  // TypeScript check (only with a local install: `npx tsc` without one
  // downloads the unrelated "tsc" package from npm)
  const tsconfigExists = await fileExists(path.join(projectDir, 'tsconfig.json'));
  if (tsconfigExists && !await hasLocalBin(projectDir, 'tsc')) {
    checks.push({ name: 'typecheck', domain: 'code', status: 'skip', detail: 'typescript is not installed in node_modules' });
  } else if (tsconfigExists) {
    const npx = platformCommand('npx', ['tsc', '--noEmit', '--pretty', 'false']);
    checks.push(commandCheck('typecheck', 'tsc', await runCommand(projectDir, npx.command, npx.args, timeout, signal)));
  } else {
    checks.push({ name: 'typecheck', domain: 'code', status: 'skip', detail: 'No tsconfig.json found' });
  }

  // Lint check (eslint)
  if (!quick) {
    const eslintConfig = await hasAnyFile(projectDir, ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts']);
    if (eslintConfig && !await hasLocalBin(projectDir, 'eslint')) {
      checks.push({ name: 'lint', domain: 'code', status: 'skip', detail: 'eslint is not installed in node_modules' });
    } else if (eslintConfig) {
      const npx = platformCommand('npx', ['eslint', '.']);
      checks.push(commandCheck('lint', 'eslint', await runCommand(projectDir, npx.command, npx.args, timeout, signal)));
    } else {
      checks.push({ name: 'lint', domain: 'code', status: 'skip', detail: 'No ESLint config found' });
    }
  }

  // Test check
  if (!quick) {
    checks.push(await runTests(projectDir, timeout * 2, signal));
  }

  return {
    domain: 'code',
    overall: deriveOverall(checks),
    checks,
    timestamp: new Date().toISOString(),
  };
}

async function runTests(projectDir: string, timeout: number, signal?: AbortSignal): Promise<VerificationCheck> {
  const packageJson = await readPackageJson(projectDir);
  const testScript = packageJson?.scripts?.test;
  if (testScript && !/no test specified/i.test(testScript)) {
    // --passWithNoTests is a jest/vitest flag; other runners may reject it.
    const extra = /\b(jest|vitest)\b/.test(testScript) ? ['--', '--passWithNoTests'] : [];
    const npm = platformCommand('npm', ['test', ...extra]);
    return commandCheck('tests', 'npm', await runCommand(projectDir, npm.command, npm.args, timeout, signal));
  }
  if (await hasAnyFile(projectDir, ['pytest.ini', 'conftest.py', 'tox.ini']) || await fileContains(path.join(projectDir, 'pyproject.toml'), '[tool.pytest')) {
    const run = await runCommand(projectDir, 'python', ['-m', 'pytest', '-q'], timeout, signal);
    // pytest exit code 5: no tests were collected.
    if (!run.ok && /exit code:? 5\b|no tests ran/i.test(run.output)) return { name: 'tests', domain: 'code', status: 'skip', detail: 'pytest collected no tests', duration_ms: run.duration_ms };
    if (!run.ok && /No module named pytest/i.test(run.output)) return { name: 'tests', domain: 'code', status: 'skip', detail: 'pytest is not installed', duration_ms: run.duration_ms };
    return commandCheck('tests', 'pytest', run);
  }
  if (await fileExists(path.join(projectDir, 'go.mod'))) {
    return commandCheck('tests', 'go', await runCommand(projectDir, 'go', ['test', './...'], timeout, signal));
  }
  if (await fileExists(path.join(projectDir, 'Cargo.toml'))) {
    return commandCheck('tests', 'cargo', await runCommand(projectDir, 'cargo', ['test', '--quiet'], timeout, signal));
  }
  return { name: 'tests', domain: 'code', status: 'skip', detail: 'No test runner detected' };
}

function platformCommand(command: 'npm' | 'npx', args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args };
  const cliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command}-cli.js`);
  return { command: process.execPath, args: [cliPath, ...args] };
}

// ─── Service verification ───────────────────────────────────────────

export async function verifyService(projectDir: string, serviceId: string): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  const serviceDir = path.join(projectDir, '.harness', 'services', serviceId);

  // service.json exists and is valid
  const serviceOk = await isValidJson(path.join(serviceDir, 'service.json'));
  checks.push({ name: 'service_definition', domain: 'service', status: serviceOk ? 'pass' : 'fail', detail: serviceOk ? undefined : 'service.json missing or invalid' });

  // state.json exists and is valid
  const stateOk = await isValidJson(path.join(serviceDir, 'state.json'));
  checks.push({ name: 'state_exists', domain: 'service', status: stateOk ? 'pass' : 'fail', detail: stateOk ? undefined : 'state.json missing or invalid' });

  // lifecycle.json exists
  const lifecycleOk = await isValidJson(path.join(serviceDir, 'lifecycle.json'));
  checks.push({ name: 'lifecycle_tracked', domain: 'service', status: lifecycleOk ? 'pass' : 'warn', detail: lifecycleOk ? undefined : 'No lifecycle tracking (optional)' });

  // Has supported commands
  if (serviceOk) {
    try {
      const raw = await fs.readFile(path.join(serviceDir, 'service.json'), 'utf-8');
      const def = JSON.parse(raw);
      const hasCmds = Array.isArray(def.supported_commands) && def.supported_commands.length > 0;
      checks.push({ name: 'commands_defined', domain: 'service', status: hasCmds ? 'pass' : 'warn', detail: hasCmds ? `${def.supported_commands.length} commands` : 'No commands defined' });
      const hasSchedule = Array.isArray(def.schedules) && def.schedules.length > 0;
      checks.push({ name: 'schedule_defined', domain: 'service', status: hasSchedule ? 'pass' : 'warn', detail: hasSchedule ? undefined : 'No schedule defined' });
    } catch {
      checks.push({ name: 'commands_defined', domain: 'service', status: 'skip' });
    }
  }

  return {
    domain: 'service',
    overall: deriveOverall(checks),
    checks,
    timestamp: new Date().toISOString(),
  };
}

// ─── Promise verification ───────────────────────────────────────────

export interface PromiseVerifyInput {
  commitment: string;
  capability_required?: string;
  schedule_exists: boolean;
  notification_path_available: boolean;
}

export function verifyPromiseFulfillability(input: PromiseVerifyInput): VerificationResult {
  const checks: VerificationCheck[] = [];

  // Can actually schedule if time-based
  const isTimeBased = /remind|daily|weekly|every|check|monitor|recurring/i.test(input.commitment);
  if (isTimeBased) {
    checks.push({ name: 'schedule_backing', domain: 'promise', status: input.schedule_exists ? 'pass' : 'fail', detail: input.schedule_exists ? undefined : 'Time-based promise has no backing schedule' });
    checks.push({ name: 'notification_path', domain: 'promise', status: input.notification_path_available ? 'pass' : 'warn', detail: input.notification_path_available ? undefined : 'No notification channel — will use service inbox fallback' });
  }

  // Capability check
  if (input.capability_required) {
    checks.push({ name: 'capability_available', domain: 'promise', status: 'warn', detail: `Requires capability: ${input.capability_required}` });
  }

  return {
    domain: 'promise',
    overall: deriveOverall(checks),
    checks,
    timestamp: new Date().toISOString(),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function deriveOverall(checks: VerificationCheck[]): VerificationStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  if (checks.every((c) => c.status === 'skip')) return 'skip';
  return 'pass';
}

async function fileExists(fp: string): Promise<boolean> {
  try { await fs.access(fp); return true; } catch { return false; }
}

async function hasAnyFile(dir: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await fileExists(path.join(dir, name))) return true;
  }
  return false;
}

/** Whether node_modules/.bin (here or in a parent, for hoisted monorepos) has the tool. */
async function hasLocalBin(dir: string, name: string): Promise<boolean> {
  let current = path.resolve(dir);
  for (let i = 0; i < 6; i++) {
    if (await fileExists(path.join(current, 'node_modules', '.bin', name))) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

async function fileContains(fp: string, needle: string): Promise<boolean> {
  try {
    return (await fs.readFile(fp, 'utf-8')).includes(needle);
  } catch {
    return false;
  }
}

async function isValidJson(fp: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(fp, 'utf-8');
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(dir: string): Promise<{ scripts?: Record<string, string> } | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
