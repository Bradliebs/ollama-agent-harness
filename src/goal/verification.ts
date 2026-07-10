// Active Goal — verification runners.
//
// One runner per GoalCheckKind. Each runner takes the check spec plus
// any kind-specific context (a model judge function, a fetch impl) and
// returns a GoalCheckResult that goes straight into the goal's evidence
// trail.
//
// Runners must NEVER throw — they catch their own errors and return
// passed:false with the error in `evidence`. The loop relies on this
// to keep iterating.

import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  GoalCheck,
  GoalCheckResult,
  GoalCheckSpec,
} from './types';

const execFileAsync = promisify(execFile);

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const MAX_EVIDENCE_CHARS = 4_000;

function truncate(s: string): string {
  if (s.length <= MAX_EVIDENCE_CHARS) return s;
  return `${s.slice(0, MAX_EVIDENCE_CHARS)}\n…(truncated; ${s.length - MAX_EVIDENCE_CHARS} more chars)`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Model judge contract ────────────────────────────────────────────

export interface ModelJudgeRequest {
  rubric: string;
  goalTarget: string;
}

export interface ModelJudgeResponse {
  score: number;          // 0..1
  rationale: string;
}

export type ModelJudgeFn = (req: ModelJudgeRequest) => Promise<ModelJudgeResponse>;

// ─── Runner ──────────────────────────────────────────────────────────

export interface RunCheckContext {
  goalTarget: string;
  judge?: ModelJudgeFn;
  // Caller may inject a fetch impl for tests; defaults to globalThis.fetch.
  fetchImpl?: typeof fetch;
}

export async function runCheck(check: GoalCheck, ctx: RunCheckContext): Promise<GoalCheckResult> {
  const start = Date.now();
  try {
    switch (check.spec.kind) {
      case 'command':     return await runCommand(check.spec, start);
      case 'file_exists': return await runFileExists(check.spec, start);
      case 'http':        return await runHttp(check.spec, ctx.fetchImpl ?? fetch, start);
      case 'model_judge': return await runModelJudge(check.spec, ctx, start);
      case 'test_suite':  return await runTestSuite(check.spec, start);
    }
  } catch (err) {
    return {
      passed: false,
      timestamp: nowIso(),
      evidence: `runner threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─── command ─────────────────────────────────────────────────────────

async function runCommand(spec: Extract<GoalCheckSpec, { kind: 'command' }>, start: number): Promise<GoalCheckResult> {
  const expectExit = spec.expectExitCode ?? 0;
  const timeout = spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let exitCode = 0;
  let output = '';
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      timeout,
      windowsHide: true,
    });
    output = `${stdout}\n${stderr}`.trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    exitCode = typeof e.code === 'number' ? e.code : 1;
    output = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.trim();
  }
  let passed = exitCode === expectExit;
  if (passed && spec.expectStdoutMatches) {
    passed = new RegExp(spec.expectStdoutMatches).test(output);
  }
  return {
    passed,
    timestamp: nowIso(),
    evidence: truncate(`exit=${exitCode}\n${output}`),
    durationMs: Date.now() - start,
  };
}

// ─── file_exists ─────────────────────────────────────────────────────

async function runFileExists(spec: Extract<GoalCheckSpec, { kind: 'file_exists' }>, start: number): Promise<GoalCheckResult> {
  try {
    const abs = path.resolve(spec.path);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return { passed: false, timestamp: nowIso(), evidence: `${abs} exists but is not a regular file`, durationMs: Date.now() - start };
    }
    if (spec.mustContain) {
      const content = await fs.readFile(abs, 'utf-8');
      const passed = new RegExp(spec.mustContain).test(content);
      return {
        passed,
        timestamp: nowIso(),
        evidence: passed ? `file present, pattern matched` : `file present, pattern '${spec.mustContain}' NOT matched`,
        durationMs: Date.now() - start,
      };
    }
    return { passed: true, timestamp: nowIso(), evidence: `file present (${stat.size} bytes)`, durationMs: Date.now() - start };
  } catch (err) {
    return {
      passed: false,
      timestamp: nowIso(),
      evidence: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─── http ────────────────────────────────────────────────────────────

async function runHttp(spec: Extract<GoalCheckSpec, { kind: 'http' }>, fetchImpl: typeof fetch, start: number): Promise<GoalCheckResult> {
  const expectStatus = spec.expectStatus ?? 200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(spec.url, { signal: controller.signal });
    const body = await res.text();
    let passed = res.status === expectStatus;
    if (passed && spec.expectBodyMatches) {
      passed = new RegExp(spec.expectBodyMatches).test(body);
    }
    return {
      passed,
      timestamp: nowIso(),
      evidence: truncate(`status=${res.status}\n${body}`),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      passed: false,
      timestamp: nowIso(),
      evidence: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── model_judge ─────────────────────────────────────────────────────

async function runModelJudge(spec: Extract<GoalCheckSpec, { kind: 'model_judge' }>, ctx: RunCheckContext, start: number): Promise<GoalCheckResult> {
  if (!ctx.judge) {
    return {
      passed: false,
      timestamp: nowIso(),
      evidence: 'no model judge provided in RunCheckContext',
      durationMs: Date.now() - start,
    };
  }
  const minScore = spec.minScore ?? 0.7;
  const { score, rationale } = await ctx.judge({ rubric: spec.rubric, goalTarget: ctx.goalTarget });
  return {
    passed: score >= minScore,
    timestamp: nowIso(),
    evidence: truncate(`score=${score} (min ${minScore})\n${rationale}`),
    durationMs: Date.now() - start,
    judgeScore: score,
  };
}

// ─── test_suite ──────────────────────────────────────────────────────

// Parse Jest summary line: "Tests:       12 passed, 1 failed, 13 total"
// Returns null if no recognisable summary present.
export function parseJestSummary(output: string): { passed: number; failed: number; total: number } | null {
  const m = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(\d+)\s+passed(?:,\s+(\d+)\s+skipped)?(?:,\s+(\d+)\s+failed)?,\s+(\d+)\s+total/);
  if (!m) return null;
  const failedA = parseInt(m[1] ?? '0', 10);
  const passed = parseInt(m[3], 10);
  const failedB = parseInt(m[5] ?? '0', 10);
  const total = parseInt(m[6], 10);
  const failed = failedA + failedB;
  return { passed, failed, total };
}

async function runTestSuite(spec: Extract<GoalCheckSpec, { kind: 'test_suite' }>, start: number): Promise<GoalCheckResult> {
  const timeout = spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS * 2;
  let exitCode = 0;
  let output = '';
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      timeout,
      windowsHide: true,
    });
    output = `${stdout}\n${stderr}`.trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    exitCode = typeof e.code === 'number' ? e.code : 1;
    output = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.trim();
  }
  const counts = parseJestSummary(output);
  if (counts && spec.minPassRate !== undefined) {
    const rate = counts.total > 0 ? counts.passed / counts.total : 0;
    const passed = rate >= spec.minPassRate;
    return {
      passed,
      timestamp: nowIso(),
      evidence: truncate(`exit=${exitCode}\npassRate=${rate.toFixed(3)} (min ${spec.minPassRate})\n${output}`),
      durationMs: Date.now() - start,
      testCounts: counts,
    };
  }
  // No minPassRate or no parseable summary: fall back to exit code.
  return {
    passed: exitCode === 0,
    timestamp: nowIso(),
    evidence: truncate(`exit=${exitCode}\n${output}`),
    durationMs: Date.now() - start,
    testCounts: counts ?? undefined,
  };
}

// ─── Batch runner ────────────────────────────────────────────────────

export interface BatchResult {
  results: Array<{ check: GoalCheck; result: GoalCheckResult }>;
  allRequiredPassed: boolean;
  requiredCount: number;
  requiredPassed: number;
}

export async function runAllChecks(checks: GoalCheck[], ctx: RunCheckContext): Promise<BatchResult> {
  const results = await Promise.all(checks.map(async (c) => ({ check: c, result: await runCheck(c, ctx) })));
  const required = results.filter((r) => r.check.required);
  const requiredPassed = required.filter((r) => r.result.passed).length;
  return {
    results,
    allRequiredPassed: requiredPassed === required.length,
    requiredCount: required.length,
    requiredPassed,
  };
}
