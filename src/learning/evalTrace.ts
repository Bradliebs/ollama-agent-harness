import * as fs from 'fs/promises';
import * as path from 'path';
import type { TraceEvent, TraceRecord } from '../core/tracing';

export interface TraceSnapshot {
  spans: TraceRecord[];
  events: TraceEvent[];
}

export interface EvalTraceExample {
  id: string;
  createdAt: string;
  mode?: 'trace' | 'replay';
  task: string;
  expectedBehavior: string;
  status: 'pass' | 'fail';
  spanNames: string[];
  eventNames: string[];
  tags: string[];
  error?: string;
  prompt?: string;
  expectedResponseIncludes?: string[];
  expectedTools?: string[];
  actualResponse?: string;
  actualTools?: string[];
  sourceTraceId?: string;
  sourceSessionId?: string;
  sourceContext?: string;
}

export interface EvalTraceRunResult {
  exampleId: string;
  task: string;
  status: 'pass' | 'fail';
  expectedStatus: 'pass' | 'fail';
  actualStatus: 'pass' | 'fail';
  tags: string[];
  message: string;
  checks?: string[];
  links?: ReplayEvalSourceLinks;
}

export interface EvalTraceRun {
  id: string;
  createdAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: EvalTraceRunResult[];
}

export interface EvalTraceRunTrend {
  totalRuns: number;
  latest?: EvalTraceRun;
  averagePassRate: number;
  byTag: Record<string, { total: number; passed: number; failed: number; passRate: number }>;
}

export interface EvalTraceOptions {
  task?: string;
  expectedBehavior?: string;
  tags?: string[];
}

export interface ReplayEvalOptions {
  task: string;
  prompt: string;
  expectedBehavior?: string;
  expectedResponseIncludes?: string[];
  expectedTools?: string[];
  actualResponse?: string;
  actualTools?: string[];
  sourceTraceId?: string;
  sourceSessionId?: string;
  sourceContext?: string;
  tags?: string[];
}

export interface ReplayEvalSourceLinks {
  traceUrl?: string;
  sessionUrl?: string;
  context?: string;
}

export interface ReplayEvalActuals {
  actualResponse?: string;
  actualTools?: string[];
}

export interface ReplayEvalRunOptions {
  replayAdapter?: (example: EvalTraceExample) => Promise<ReplayEvalActuals>;
}

export function createEvalTraceExample(
  snapshot: TraceSnapshot,
  options: EvalTraceOptions = {},
): EvalTraceExample {
  const failedSpan = snapshot.spans.find((span) => span.status === 'error');
  const spanNames = Array.from(new Set(snapshot.spans.map((span) => span.name)));
  const eventNames = Array.from(new Set(snapshot.events.map((event) => event.name)));
  const status = failedSpan ? 'fail' : 'pass';

  return {
    id: `trace:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    mode: 'trace',
    task: options.task ?? inferTask(snapshot),
    expectedBehavior: options.expectedBehavior ?? (status === 'pass' ? 'complete without trace errors' : 'surface and recover from trace error'),
    status,
    spanNames,
    eventNames,
    tags: options.tags ?? inferTags(spanNames, eventNames, status),
    error: failedSpan?.error,
  };
}

export function createReplayEvalExample(options: ReplayEvalOptions): EvalTraceExample {
  const replayStatus = evaluateReplayStatus({
    expectedResponseIncludes: options.expectedResponseIncludes ?? [],
    expectedTools: options.expectedTools ?? [],
    actualResponse: options.actualResponse,
    actualTools: options.actualTools,
  });
  return {
    id: `replay:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    mode: 'replay',
    task: options.task,
    expectedBehavior: options.expectedBehavior ?? 'model response should satisfy replay expectations',
    status: replayStatus.status,
    spanNames: [],
    eventNames: [],
    tags: options.tags ?? ['replay'],
    error: replayStatus.status === 'fail' ? replayStatus.message : undefined,
    prompt: options.prompt,
    expectedResponseIncludes: options.expectedResponseIncludes ?? [],
    expectedTools: options.expectedTools ?? [],
    actualResponse: options.actualResponse,
    actualTools: options.actualTools ?? [],
    sourceTraceId: options.sourceTraceId,
    sourceSessionId: options.sourceSessionId,
    sourceContext: options.sourceContext,
  };
}

export async function appendEvalTraceExample(
  projectDir: string,
  example: EvalTraceExample,
): Promise<string> {
  const filePath = evalTraceExamplesPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(example) + '\n', 'utf-8');
  return filePath;
}

export async function listEvalTraceExamples(
  projectDir: string,
  limit = 20,
): Promise<EvalTraceExample[]> {
  const filePath = evalTraceExamplesPath(projectDir);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvalTraceExample)
      .slice(-limit);
  } catch {
    return [];
  }
}

export async function readEvalTraceDataset(projectDir: string): Promise<string> {
  try {
    return await fs.readFile(evalTraceExamplesPath(projectDir), 'utf-8');
  } catch {
    return '';
  }
}

export async function updateEvalTraceExampleTags(
  projectDir: string,
  exampleId: string,
  tags: string[],
): Promise<EvalTraceExample> {
  const examples = await listEvalTraceExamples(projectDir, 1000);
  const index = examples.findIndex((example) => example.id === exampleId);
  if (index < 0) {
    throw new Error(`Eval trace example not found: ${exampleId}`);
  }
  const normalizedTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  examples[index] = { ...examples[index], tags: normalizedTags };
  await writeEvalTraceExamples(projectDir, examples);
  return examples[index];
}

export async function deleteEvalTraceExample(projectDir: string, exampleId: string): Promise<boolean> {
  const examples = await listEvalTraceExamples(projectDir, 1000);
  const remaining = examples.filter((example) => example.id !== exampleId);
  if (remaining.length === examples.length) {
    return false;
  }
  await writeEvalTraceExamples(projectDir, remaining);
  return true;
}

export async function runEvalTraceDataset(projectDir: string, options: ReplayEvalRunOptions = {}): Promise<EvalTraceRun> {
  const examples = await listEvalTraceExamples(projectDir, 1000);
  const results = await Promise.all(examples.map((example) => evaluateTraceExample(example, options)));
  const passed = results.filter((result) => result.status === 'pass').length;
  const run: EvalTraceRun = {
    id: `eval-run:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: rate(passed, results.length),
    results,
  };
  await appendEvalTraceRun(projectDir, run);
  return run;
}

export async function listEvalTraceRuns(projectDir: string, limit = 20): Promise<EvalTraceRun[]> {
  try {
    const raw = await fs.readFile(evalTraceRunsPath(projectDir), 'utf-8');
    return raw.trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvalTraceRun)
      .slice(-limit);
  } catch {
    return [];
  }
}

export function summarizeEvalTraceRuns(runs: EvalTraceRun[]): EvalTraceRunTrend {
  const latest = runs.at(-1);
  const byTag: EvalTraceRunTrend['byTag'] = {};
  for (const run of runs) {
    for (const result of run.results) {
      const tags = result.tags.length > 0 ? result.tags : ['untagged'];
      for (const tag of tags) {
        const bucket = byTag[tag] ?? { total: 0, passed: 0, failed: 0, passRate: 0 };
        bucket.total++;
        if (result.status === 'pass') bucket.passed++;
        else bucket.failed++;
        bucket.passRate = rate(bucket.passed, bucket.total);
        byTag[tag] = bucket;
      }
    }
  }
  const average = runs.reduce((sum, run) => sum + run.passRate, 0);
  return {
    totalRuns: runs.length,
    latest,
    averagePassRate: rate(average, runs.length),
    byTag,
  };
}

async function evaluateTraceExample(example: EvalTraceExample, options: ReplayEvalRunOptions = {}): Promise<EvalTraceRunResult> {
  if (example.mode === 'replay') {
    return evaluateReplayExample(example, options);
  }
  const expectedStatus = example.tags.includes('expected-fail') ? 'fail' : 'pass';
  const matches = example.status === expectedStatus;
  const message = matches
    ? `Expected ${expectedStatus} trace status was observed.`
    : `Expected ${expectedStatus} trace status but observed ${example.status}.`;
  return {
    exampleId: example.id,
    task: example.task,
    status: matches ? 'pass' : 'fail',
    expectedStatus,
    actualStatus: example.status,
    tags: example.tags,
    message,
  };
}

async function evaluateReplayExample(example: EvalTraceExample, options: ReplayEvalRunOptions): Promise<EvalTraceRunResult> {
  const actuals = needsReplayAdapter(example) && options.replayAdapter
    ? await options.replayAdapter(example)
    : {};
  const replayStatus = evaluateReplayStatus({
    ...example,
    actualResponse: actuals.actualResponse ?? example.actualResponse,
    actualTools: actuals.actualTools ?? example.actualTools,
  });
  return {
    exampleId: example.id,
    task: example.task,
    status: replayStatus.status,
    expectedStatus: 'pass',
    actualStatus: replayStatus.status,
    tags: example.tags,
    message: replayStatus.message,
    checks: replayStatus.checks,
    links: buildReplaySourceLinks(example),
  };
}

function needsReplayAdapter(example: EvalTraceExample): boolean {
  return !example.actualResponse && (!example.actualTools || example.actualTools.length === 0);
}

function buildReplaySourceLinks(example: EvalTraceExample): ReplayEvalSourceLinks | undefined {
  const links: ReplayEvalSourceLinks = {};
  if (example.sourceTraceId) links.traceUrl = `/api/traces/exports/${encodeURIComponent(example.sourceTraceId)}`;
  if (example.sourceSessionId) links.sessionUrl = `/api/sessions/${encodeURIComponent(example.sourceSessionId)}`;
  if (example.sourceContext) links.context = example.sourceContext;
  return links.traceUrl || links.sessionUrl || links.context ? links : undefined;
}

function evaluateReplayStatus(example: Pick<EvalTraceExample, 'expectedResponseIncludes' | 'expectedTools' | 'actualResponse' | 'actualTools'>): { status: 'pass' | 'fail'; message: string; checks: string[] } {
  const checks: string[] = [];
  const actualResponse = (example.actualResponse ?? '').toLowerCase();
  const actualTools = new Set((example.actualTools ?? []).map((tool) => tool.toLowerCase()));
  const missingFragments = (example.expectedResponseIncludes ?? []).filter((fragment) => !actualResponse.includes(fragment.toLowerCase()));
  const missingTools = (example.expectedTools ?? []).filter((tool) => !actualTools.has(tool.toLowerCase()));
  if ((example.expectedResponseIncludes ?? []).length > 0) checks.push('expected response fragments');
  if ((example.expectedTools ?? []).length > 0) checks.push('expected tool calls');
  if (missingFragments.length === 0 && missingTools.length === 0 && checks.length > 0) {
    return { status: 'pass', message: 'Replay expectations were satisfied.', checks };
  }
  const issues: string[] = [];
  if (checks.length === 0) issues.push('no replay expectations configured');
  if (missingFragments.length > 0) issues.push(`missing response fragments: ${missingFragments.join(', ')}`);
  if (missingTools.length > 0) issues.push(`missing tools: ${missingTools.join(', ')}`);
  return { status: 'fail', message: issues.join('; '), checks };
}

async function appendEvalTraceRun(projectDir: string, run: EvalTraceRun): Promise<void> {
  const filePath = evalTraceRunsPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(run) + '\n', 'utf-8');
}

function inferTask(snapshot: TraceSnapshot): string {
  const modelSpan = snapshot.spans.find((span) => span.name === 'model.chat');
  const model = modelSpan?.attributes.model;
  return typeof model === 'string' ? `model interaction with ${model}` : 'runtime trace evaluation';
}

function inferTags(spanNames: string[], eventNames: string[], status: 'pass' | 'fail'): string[] {
  const tags = new Set<string>([status]);
  if (spanNames.some((name) => name.startsWith('tool.'))) tags.add('tools');
  if (spanNames.some((name) => name.startsWith('model.'))) tags.add('model');
  if (eventNames.some((name) => name.startsWith('session.'))) tags.add('session');
  if (spanNames.some((name) => name.startsWith('context.'))) tags.add('context');
  return Array.from(tags);
}

async function writeEvalTraceExamples(projectDir: string, examples: EvalTraceExample[]): Promise<void> {
  const filePath = evalTraceExamplesPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, examples.map((example) => JSON.stringify(example)).join('\n') + (examples.length ? '\n' : ''), 'utf-8');
}

function evalTraceExamplesPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'evals', 'trace-examples.jsonl');
}

function evalTraceRunsPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'evals', 'trace-runs.jsonl');
}

function rate(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(3)) : 0;
}