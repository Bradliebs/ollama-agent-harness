// Benchmark task runner — Gap #2 in the harness reliability audit.
//
// A tiered benchmark suite that the harness can run against any model
// to measure real competence (not just safety reflexes):
//
//   Tier 1: canned   — simple, fast, deterministic sanity tasks
//   Tier 2: stress   — realistic, multi-step tasks
//   Tier 3: adversarial — tasks designed to expose shortcuts / hallucination
//   Tier 4: regression  — auto-grows from past failures (loaded from disk)
//
// The runner drives the daemon's /api/chat SSE endpoint, collects
// text + tool calls, scores with explicit pass criteria, and writes a
// JSON result file so the results compound over time.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Schema ──────────────────────────────────────────────────────────

export type BenchmarkTier = 'canned' | 'stress' | 'adversarial' | 'regression';

export type FailureCategory =
  | 'WRONG_ANSWER'
  | 'PARTIAL_COMPLETION'
  | 'DID_NOT_RUN_TOOLS'
  | 'HALLUCINATED_API'
  | 'HALLUCINATED_FILE'
  | 'OVER_EDITED'
  | 'UNDER_EDITED'
  | 'TIMEOUT'
  | 'TOOL_LOOP'
  | 'REFUSAL_WRONG'
  | 'REFUSAL_CORRECT'
  | 'FORMAT_FAIL'
  | 'NO_EVIDENCE'
  | 'ERROR';

export interface BenchmarkTask {
  id: string;
  tier: BenchmarkTier;
  description: string;
  /** The user message text sent to /api/chat. */
  input: string;
  /** Substrings the response MUST contain (case-insensitive). */
  expectIncludes?: string[];
  /** Substrings the response MUST NOT contain (case-insensitive). */
  expectMissing?: string[];
  /** Tool names that MUST have been called at least once. */
  requireTools?: string[];
  /** Tool names that MUST NOT be called. */
  forbiddenTools?: string[];
  /**
   * Custom scorer: given the text response and tool calls, returns a
   * pass/fail verdict with a reason. Runs after include/missing checks.
   */
  customScorer?: (response: string, toolCalls: string[]) => { pass: boolean; reason: string };
  /** Tags for filtering. */
  tags?: string[];

  // ── Task contract fields (Gap #4) ──
  /** Human-readable definition of what "done" means for this task. */
  definitionOfDone?: string;
  /** Explicit failure conditions beyond generic scorer checks. */
  failConditions?: string[];
  /** Tools the agent is allowed to use. When set, any other tool call fails the task. */
  toolsAllowed?: string[];
  /** Maximum turns the agent may take before the task is considered timed-out. */
  maxTurns?: number;
  /** Expected output artifacts (file paths, format types, etc). */
  expectedArtifacts?: string[];
  /** Difficulty rating for reporting purposes (1–5). */
  difficulty?: number;
}

export interface BenchmarkTaskResult {
  taskId: string;
  tier: BenchmarkTier;
  description: string;
  status: 'pass' | 'fail' | 'error';
  failureCategory?: FailureCategory;
  reason: string;
  responsePreview: string;
  toolCalls: string[];
  durationMs: number;
  tags: string[];
}

export interface BenchmarkRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  baseUrl: string;
  tiers: BenchmarkTier[];
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  /** Ratio of passes to cost (approximated as total turns — real cost tracking is Gap #5). */
  passTurnRatio?: number;
  results: BenchmarkTaskResult[];
}

// ─── SSE stream consumer (shared with simulator.ts) ──────────────────

interface StreamObservation {
  responseText: string;
  toolCalls: string[];
  turnCount: number;
}

async function consumeChatStream(response: Response, timeoutMs: number): Promise<StreamObservation> {
  if (!response.ok || !response.body) {
    throw new Error(`/api/chat returned ${response.status}`);
  }
  const reader = (response.body as unknown as { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } }).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseText = '';
  const toolCalls: string[] = [];
  let turnCount = 0;
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > timeoutMs) break;
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.startsWith('data: ')) continue;
      const payloadText = line.slice(6);
      if (payloadText === '[DONE]') return { responseText, toolCalls, turnCount };
      try {
        const event = JSON.parse(payloadText) as { type?: string; content?: string; call?: { name?: string }; turn?: number };
        if (event.type === 'text' && typeof event.content === 'string') responseText += event.content;
        else if (event.type === 'tool_call' && event.call?.name) toolCalls.push(event.call.name);
        else if (event.type === 'turn_complete') turnCount = (event.turn ?? 0) + 1;
        else if (event.type === 'done') return { responseText, toolCalls, turnCount };
      } catch { /* skip malformed lines */ }
    }
  }
  return { responseText, toolCalls, turnCount };
}

// ─── Scorer ──────────────────────────────────────────────────────────

function scoreTask(task: BenchmarkTask, obs: StreamObservation): { pass: boolean; reason: string; failureCategory?: FailureCategory } {
  const lower = obs.responseText.toLowerCase();

  for (const banned of (task.expectMissing ?? [])) {
    if (banned && lower.includes(banned.toLowerCase())) {
      return { pass: false, reason: `Response contained banned substring: "${banned}"`, failureCategory: 'WRONG_ANSWER' };
    }
  }
  for (const required of (task.expectIncludes ?? [])) {
    if (required && !lower.includes(required.toLowerCase())) {
      return { pass: false, reason: `Response missing required substring: "${required}"`, failureCategory: 'WRONG_ANSWER' };
    }
  }
  if (task.requireTools && task.requireTools.length > 0) {
    const used = new Set(obs.toolCalls);
    for (const req of task.requireTools) {
      if (!used.has(req)) {
        return { pass: false, reason: `Required tool "${req}" was not called`, failureCategory: 'DID_NOT_RUN_TOOLS' };
      }
    }
  }
  if (task.forbiddenTools && task.forbiddenTools.length > 0) {
    const used = new Set(obs.toolCalls);
    for (const banned of task.forbiddenTools) {
      if (used.has(banned)) {
        return { pass: false, reason: `Forbidden tool "${banned}" was invoked`, failureCategory: 'REFUSAL_CORRECT' };
      }
    }
  }
  // Task contract: toolsAllowed (Gap #4) — if set, any call outside this set fails.
  if (task.toolsAllowed && task.toolsAllowed.length > 0) {
    const allowed = new Set(task.toolsAllowed);
    for (const called of obs.toolCalls) {
      if (!allowed.has(called)) {
        return { pass: false, reason: `Tool "${called}" is not in toolsAllowed`, failureCategory: 'REFUSAL_CORRECT' };
      }
    }
  }
  if (task.customScorer) {
    const custom = task.customScorer(obs.responseText, obs.toolCalls);
    if (!custom.pass) {
      return { pass: false, reason: custom.reason, failureCategory: 'WRONG_ANSWER' };
    }
  }
  return { pass: true, reason: 'All criteria satisfied' };
}

// ─── Runner ──────────────────────────────────────────────────────────

export interface BenchmarkRunOptions {
  /** Daemon base URL. Default http://127.0.0.1:4300. */
  baseUrl?: string;
  /** Model to use. */
  model?: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Task set; defaults to BUILT_IN_TASKS. */
  tasks?: BenchmarkTask[];
  /** Which tiers to run; defaults to all. */
  tiers?: BenchmarkTier[];
  /** Specific task IDs to run (overrides tiers filter). */
  filterIds?: string[];
  /** Per-task timeout in ms. Default 60_000. */
  perTaskTimeoutMs?: number;
  /**
   * Optional system-prompt override sent with each /api/chat request. Used by
   * the experiment runner to evaluate prompt-scope mutations (the daemon only
   * honors it when HARNESS_EXPERIMENT_PROMPT_OVERRIDE=1).
   */
  systemPrompt?: string;
  /**
   * Project directory for persisting run results and regression tasks.
   * When set, results are written to <projectDir>/.harness/benchmarks/.
   */
  projectDir?: string;
}

/** Select tasks from the given set filtered by options. */
export function selectTasks(options: BenchmarkRunOptions, allTasks: BenchmarkTask[]): BenchmarkTask[] {
  if (options.filterIds && options.filterIds.length > 0) {
    const allow = new Set(options.filterIds);
    return allTasks.filter((t) => allow.has(t.id));
  }
  if (options.tiers && options.tiers.length > 0) {
    const allow = new Set(options.tiers);
    return allTasks.filter((t) => allow.has(t.tier));
  }
  return allTasks;
}

/**
 * Run a single benchmark task against the daemon.
 */
export async function runBenchmarkTask(task: BenchmarkTask, options: BenchmarkRunOptions = {}): Promise<BenchmarkTaskResult> {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:4300').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.perTaskTimeoutMs ?? 60_000;
  const startedAt = Date.now();

  if (!fetchImpl) {
    return {
      taskId: task.id,
      tier: task.tier,
      description: task.description,
      status: 'error',
      failureCategory: 'ERROR',
      reason: 'global fetch unavailable',
      responsePreview: '',
      toolCalls: [],
      durationMs: 0,
      tags: task.tags ?? [],
    };
  }

  let obs: StreamObservation;
  try {
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        message: task.input,
        model: options.model,
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      }),
    });
    obs = await consumeChatStream(response, timeoutMs);
  } catch (error) {
    return {
      taskId: task.id,
      tier: task.tier,
      description: task.description,
      status: 'error',
      failureCategory: 'ERROR',
      reason: error instanceof Error ? error.message : String(error),
      responsePreview: '',
      toolCalls: [],
      durationMs: Date.now() - startedAt,
      tags: task.tags ?? [],
    };
  }

  const durationMs = Date.now() - startedAt;

  // Timeout heuristic: if the task hit the wall clock limit but we
  // got something back, still score it — the response may be correct.
  if (durationMs >= timeoutMs && !obs.responseText) {
    return {
      taskId: task.id,
      tier: task.tier,
      description: task.description,
      status: 'fail',
      failureCategory: 'TIMEOUT',
      reason: `Task exceeded ${timeoutMs}ms timeout with no response`,
      responsePreview: '',
      toolCalls: obs.toolCalls,
      durationMs,
      tags: task.tags ?? [],
    };
  }

  const score = scoreTask(task, obs);
  return {
    taskId: task.id,
    tier: task.tier,
    description: task.description,
    status: score.pass ? 'pass' : 'fail',
    failureCategory: score.pass ? undefined : score.failureCategory,
    reason: score.reason,
    responsePreview: obs.responseText.slice(0, 300),
    toolCalls: obs.toolCalls,
    durationMs,
    tags: task.tags ?? [],
  };
}

/**
 * Run all selected tasks sequentially and return a structured run record.
 */
export async function runBenchmark(options: BenchmarkRunOptions = {}): Promise<BenchmarkRun> {
  const { BUILT_IN_TASKS } = await import('./benchmarkTasks');
  const allTasks = [...(options.tasks ?? BUILT_IN_TASKS), ...(await loadRegressionTasks(options.projectDir))];
  const tasks = selectTasks(options, allTasks);
  const results: BenchmarkTaskResult[] = [];
  const startedAt = new Date();

  for (const task of tasks) {
    results.push(await runBenchmarkTask(task, options));
  }

  const finishedAt = new Date();
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const usedTiers = [...new Set(results.map((r) => r.tier))];

  const run: BenchmarkRun = {
    id: `bench-${startedAt.getTime()}-${crypto.randomBytes(3).toString('hex')}`,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model: options.model ?? 'unknown',
    baseUrl: (options.baseUrl ?? 'http://127.0.0.1:4300').replace(/\/$/, ''),
    tiers: usedTiers,
    total: results.length,
    passed,
    failed,
    errored,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };

  if (options.projectDir) {
    await persistBenchmarkRun(options.projectDir, run);
    // Auto-grow regression tier from any failures in this run.
    await appendRegressionCases(options.projectDir, tasks, results);
  }

  return run;
}

// ─── Persistence ─────────────────────────────────────────────────────

function benchmarkDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'benchmarks');
}

function regressionFile(projectDir: string): string {
  return path.join(benchmarkDir(projectDir), 'regressions.json');
}

export async function persistBenchmarkRun(projectDir: string, run: BenchmarkRun): Promise<void> {
  const dir = benchmarkDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${run.id}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2), 'utf-8');
}

export async function loadBenchmarkRuns(projectDir: string): Promise<BenchmarkRun[]> {
  const dir = benchmarkDir(projectDir);
  try {
    const entries = await fs.readdir(dir);
    const runs: BenchmarkRun[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'regressions.json') continue;
      try {
        const raw = await fs.readFile(path.join(dir, entry), 'utf-8');
        runs.push(JSON.parse(raw) as BenchmarkRun);
      } catch { /* skip corrupt files */ }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

/** Load regression tasks that were auto-generated from past failures. */
export async function loadRegressionTasks(projectDir?: string): Promise<BenchmarkTask[]> {
  if (!projectDir) return [];
  const file = regressionFile(projectDir);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const tasks = JSON.parse(raw) as BenchmarkTask[];
    return Array.isArray(tasks) ? tasks.filter((t) => t.tier === 'regression') : [];
  } catch {
    return [];
  }
}

/**
 * For each failed task that produced a non-empty response, record a
 * reduced regression case so it gets re-run in every future benchmark.
 * Deduplicates by task ID so re-runs don't bloat the file.
 */
async function appendRegressionCases(
  projectDir: string,
  tasks: BenchmarkTask[],
  results: BenchmarkTaskResult[],
): Promise<void> {
  const failures = results.filter((r) => r.status === 'fail' && r.responsePreview);
  if (failures.length === 0) return;

  const existing = await loadRegressionTasks(projectDir);
  const existingIds = new Set(existing.map((t) => t.id));

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  let added = 0;
  for (const failure of failures) {
    // Don't duplicate tasks that are already in the regression set.
    if (existingIds.has(failure.taskId)) continue;
    const original = taskMap.get(failure.taskId);
    if (!original) continue;
    // Promote the original task to tier=regression and add it.
    existing.push({ ...original, tier: 'regression' });
    existingIds.add(failure.taskId);
    added++;
  }

  if (added > 0) {
    const dir = benchmarkDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(regressionFile(projectDir), JSON.stringify(existing, null, 2), 'utf-8');
  }
}

/** Summary table for display: counts per tier. */
export function summarizeByTier(run: BenchmarkRun): Array<{ tier: string; total: number; passed: number; passRate: string }> {
  const map = new Map<string, { total: number; passed: number }>();
  for (const r of run.results) {
    const s = map.get(r.tier) ?? { total: 0, passed: 0 };
    s.total++;
    if (r.status === 'pass') s.passed++;
    map.set(r.tier, s);
  }
  return [...map.entries()].map(([tier, s]) => ({
    tier,
    total: s.total,
    passed: s.passed,
    passRate: s.total === 0 ? '—' : `${Math.round((s.passed / s.total) * 100)}%`,
  }));
}
