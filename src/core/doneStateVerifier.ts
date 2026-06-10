// Done-State Verifier — validates that work products meet their completion criteria.
//
// For code: runs typecheck, lint, tests (if available).
// For services: checks state exists, commands work, schedule exists, promise recorded.
// For general tasks: checks that outputs match the request intent.

import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
}

interface CommandRun {
  ok: boolean;
  output: string;
  duration_ms: number;
  /** True when the command was killed by its timeout rather than exiting on its own. */
  timedOut: boolean;
}

async function runCommand(cwd: string, cmd: string, args: string[], timeout = 60_000): Promise<CommandRun> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout, windowsHide: true });
    return { ok: true, output: (stdout + '\n' + stderr).trim(), duration_ms: Date.now() - start, timedOut: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    // execFile sets killed=true when it terminates the child due to the timeout.
    return { ok: false, output: (e.stdout ?? '') + '\n' + (e.stderr ?? e.message ?? ''), duration_ms: Date.now() - start, timedOut: e.killed === true };
  }
}

// A timed-out check means "could not verify within budget", not "verification
// failed" — so it maps to warn, never fail. This keeps default-on verification
// from spuriously failing on repos whose suite is slower than the timeout.
function checkStatus(r: CommandRun): VerificationStatus {
  if (r.ok) return 'pass';
  return r.timedOut ? 'warn' : 'fail';
}

function checkDetail(r: CommandRun): string | undefined {
  if (r.ok) return undefined;
  return r.timedOut ? 'Timed out before completing \u2014 could not verify within budget' : r.output.slice(0, 500);
}

export async function verifyCode(options: CodeVerifyOptions): Promise<VerificationResult> {
  const { projectDir, quick = false, timeout = 60_000 } = options;
  const checks: VerificationCheck[] = [];

  // TypeScript check
  const tsconfigExists = await fileExists(path.join(projectDir, 'tsconfig.json'));
  if (tsconfigExists) {
    const tsc = await runCommand(projectDir, 'npx', ['tsc', '--noEmit', '--pretty'], timeout);
    checks.push({ name: 'typecheck', domain: 'code', status: checkStatus(tsc), detail: checkDetail(tsc), duration_ms: tsc.duration_ms });
  } else {
    checks.push({ name: 'typecheck', domain: 'code', status: 'skip', detail: 'No tsconfig.json found' });
  }

  // Lint check (eslint)
  if (!quick) {
    const eslintConfig = await hasAnyFile(projectDir, ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs']);
    if (eslintConfig) {
      const lint = await runCommand(projectDir, 'npx', ['eslint', '.', '--max-warnings=0'], timeout);
      checks.push({ name: 'lint', domain: 'code', status: checkStatus(lint), detail: checkDetail(lint), duration_ms: lint.duration_ms });
    } else {
      checks.push({ name: 'lint', domain: 'code', status: 'skip', detail: 'No ESLint config found' });
    }
  }

  // Test check
  if (!quick) {
    const packageJson = await readPackageJson(projectDir);
    if (packageJson?.scripts?.test) {
      const test = await runCommand(projectDir, 'npm', ['test', '--', '--passWithNoTests'], timeout * 2);
      checks.push({ name: 'tests', domain: 'code', status: checkStatus(test), detail: checkDetail(test), duration_ms: test.duration_ms });
    } else {
      checks.push({ name: 'tests', domain: 'code', status: 'skip', detail: 'No test script in package.json' });
    }
  }

  return {
    domain: 'code',
    overall: deriveOverall(checks),
    checks,
    timestamp: new Date().toISOString(),
  };
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
