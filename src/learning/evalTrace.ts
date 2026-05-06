import * as fs from 'fs/promises';
import * as path from 'path';
import type { OutputValidationResult } from '../core/outputValidation';
import type { TraceEvent, TraceRecord } from '../core/tracing';

export type OutputValidationSelectionSource = 'auto-selected' | 'manual-selected';

export interface OutputValidationEvalRunOptions {
  selectionSource?: OutputValidationSelectionSource;
  selectionReason?: string;
}

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

export function createOutputValidationEvalRun(
  validation: OutputValidationResult,
  task = 'output validation',
  options: OutputValidationEvalRunOptions = {},
): EvalTraceRun {
  const status = validation.status === 'pass' ? 'pass' : 'fail';
  const selectionSource = options.selectionSource ?? 'manual-selected';
  const result: EvalTraceRunResult = {
    exampleId: `output-validation:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    task,
    status,
    expectedStatus: 'pass',
    actualStatus: status,
    tags: ['output-validation', validation.profile, validation.status, selectionSource],
    message: validation.status === 'pass'
      ? `Output validation passed for ${validation.profile}.`
      : `Output validation ${validation.status} for ${validation.profile}: ${validation.findings[0]?.message ?? 'see findings'}`,
    checks: validation.findings.map((finding) => finding.code),
    links: options.selectionReason ? { context: options.selectionReason } : undefined,
  };
  return {
    id: `validation-run:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    total: 1,
    passed: status === 'pass' ? 1 : 0,
    failed: status === 'pass' ? 0 : 1,
    passRate: status === 'pass' ? 1 : 0,
    results: [result],
  };
}

export async function recordOutputValidationEvalRun(
  projectDir: string,
  validation: OutputValidationResult,
  task = 'output validation',
  options: OutputValidationEvalRunOptions = {},
): Promise<EvalTraceRun> {
  const run = createOutputValidationEvalRun(validation, task, options);
  await appendEvalTraceRun(projectDir, run);
  return run;
}

export interface UploadsFallbackEvalOptions {
  uniqueFallbacks: number;
  suppressedFallbacks: number;
  tools: string[];
  sessionId?: string;
  task?: string;
}

export function createUploadsFallbackEvalRun(options: UploadsFallbackEvalOptions): EvalTraceRun | null {
  if (options.uniqueFallbacks <= 0) return null;
  const tools = Array.from(new Set(options.tools.filter(Boolean)));
  const result: EvalTraceRunResult = {
    exampleId: `uploads-fallback:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    task: (options.task ?? 'attachment usage check').slice(0, 120),
    status: 'fail',
    expectedStatus: 'pass',
    actualStatus: 'fail',
    tags: ['uploads-fallback', 'attachments'],
    message: `Model passed bare filenames ${options.uniqueFallbacks} unique time(s) (${options.suppressedFallbacks} duplicate(s) suppressed); resolver had to rewrite to .harness/uploads. Tools: ${tools.length > 0 ? tools.join(', ') : 'unknown'}.`,
  };
  return {
    id: `uploads-fallback-run:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    total: 1,
    passed: 0,
    failed: 1,
    passRate: 0,
    results: [result],
  };
}

export async function recordUploadsFallbackEvalRun(projectDir: string, options: UploadsFallbackEvalOptions): Promise<EvalTraceRun | null> {
  const run = createUploadsFallbackEvalRun(options);
  if (!run) return null;
  await appendEvalTraceRun(projectDir, run);
  return run;
}

export interface UploadsFallbackTrend {
  totalSessions: number;
  totalFallbacks: number;
  byTool: Record<string, number>;
  recent: Array<{ at: string; unique: number; tools: string[] }>;
}

export function summarizeUploadsFallbackRuns(runs: EvalTraceRun[]): UploadsFallbackTrend {
  const fallbackRuns = runs.filter((run) => run.results.some((result) => result.tags.includes('uploads-fallback')));
  const byTool: Record<string, number> = {};
  let totalFallbacks = 0;
  const recent: Array<{ at: string; unique: number; tools: string[] }> = [];
  for (const run of fallbackRuns) {
    for (const result of run.results) {
      if (!result.tags.includes('uploads-fallback')) continue;
      const uniqueMatch = result.message.match(/(\d+) unique time/);
      const unique = uniqueMatch ? Number(uniqueMatch[1]) : 0;
      totalFallbacks += unique;
      const toolsMatch = result.message.match(/Tools: ([^.]+)\./);
      const tools = toolsMatch ? toolsMatch[1].split(',').map((t) => t.trim()).filter((t) => t && t !== 'unknown') : [];
      for (const tool of tools) byTool[tool] = (byTool[tool] ?? 0) + unique;
      recent.push({ at: run.createdAt, unique, tools });
    }
  }
  return {
    totalSessions: fallbackRuns.length,
    totalFallbacks,
    byTool,
    recent: recent.slice(-10),
  };
}

export interface ContextLossDetectionInput {
  priorUserMessage: string;
  priorAssistantMessage?: string;
  assistantResponse: string;
}

export interface ContextLossDetectionResult {
  contextLoss: boolean;
  overlapTokens: string[];
  priorTokens: string[];
  responseTokens: string[];
}

const CONTEXT_LOSS_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'have', 'has', 'from', 'are', 'was', 'were', 'but',
  'not', 'you', 'your', 'our', 'their', 'them', 'these', 'those', 'into', 'over', 'under', 'about',
  'what', 'which', 'when', 'where', 'who', 'why', 'how', 'can', 'will', 'would', 'could', 'should',
  'all', 'any', 'one', 'two', 'three', 'also', 'just', 'like', 'use', 'used', 'using', 'get', 'got',
  'now', 'then', 'than', 'some', 'more', 'most', 'less', 'least', 'such', 'each', 'other', 'here',
  'there', 'its', 'his', 'her', 'him', 'she', 'they', 'been', 'being', 'does', 'did', 'doing',
  'thanks', 'please', 'okay', 'yeah', 'yes', 'sure', 'recorded', 'good',
]);

function contextLossTokens(text: string): string[] {
  if (!text) return [];
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return Array.from(new Set(tokens.filter((token) => !CONTEXT_LOSS_STOPWORDS.has(token))));
}

export function detectAssistantContextLoss(input: ContextLossDetectionInput): ContextLossDetectionResult {
  const priorTokens = Array.from(new Set([
    ...contextLossTokens(input.priorUserMessage),
    ...contextLossTokens(input.priorAssistantMessage ?? ''),
  ]));
  const responseTokens = contextLossTokens(input.assistantResponse);
  // Need enough signal on both sides before the heuristic is meaningful.
  if (priorTokens.length < 4 || responseTokens.length < 4) {
    return { contextLoss: false, overlapTokens: [], priorTokens, responseTokens };
  }
  const responseSet = new Set(responseTokens);
  const overlap = priorTokens.filter((token) => responseSet.has(token));
  return { contextLoss: overlap.length === 0, overlapTokens: overlap, priorTokens, responseTokens };
}

export interface ContextLossEvalOptions {
  priorUserMessage: string;
  priorAssistantMessage?: string;
  assistantResponse: string;
  task?: string;
}

export function createContextLossEvalRun(options: ContextLossEvalOptions): EvalTraceRun | null {
  const detection = detectAssistantContextLoss({
    priorUserMessage: options.priorUserMessage,
    priorAssistantMessage: options.priorAssistantMessage,
    assistantResponse: options.assistantResponse,
  });
  if (!detection.contextLoss) return null;
  const result: EvalTraceRunResult = {
    exampleId: `context-loss:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    task: (options.task ?? options.priorUserMessage).slice(0, 120),
    status: 'fail',
    expectedStatus: 'pass',
    actualStatus: 'fail',
    tags: ['assistant-context-loss'],
    message: `Assistant response shares no significant token with the previous turn (${detection.priorTokens.length} prior token(s) considered).`,
  };
  return {
    id: `context-loss-run:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    total: 1,
    passed: 0,
    failed: 1,
    passRate: 0,
    results: [result],
  };
}

export async function recordContextLossEvalRun(projectDir: string, options: ContextLossEvalOptions): Promise<EvalTraceRun | null> {
  const run = createContextLossEvalRun(options);
  if (!run) return null;
  await appendEvalTraceRun(projectDir, run);
  return run;
}

export interface ContextLossTrend {
  total: number;
  recent: Array<{ task: string; createdAt: string; message: string }>;
}

export function summarizeContextLossRuns(runs: EvalTraceRun[]): ContextLossTrend {
  const recent: ContextLossTrend['recent'] = [];
  let total = 0;
  for (const run of runs) {
    for (const result of run.results) {
      if (!result.tags.includes('assistant-context-loss')) continue;
      total++;
      recent.push({ task: result.task, createdAt: run.createdAt, message: result.message ?? '' });
    }
  }
  return { total, recent: recent.slice(-5).reverse() };
}

export type ProfileFeedbackVote = 'up' | 'down';

export interface ProfileFeedbackOptions {
  profile: string;
  vote: ProfileFeedbackVote;
  selectionSource?: OutputValidationSelectionSource;
  selectionReason?: string;
  prompt?: string;
}

export function createProfileFeedbackEvalRun(options: ProfileFeedbackOptions): EvalTraceRun {
  const status: 'pass' | 'fail' = options.vote === 'up' ? 'pass' : 'fail';
  const selectionSource = options.selectionSource ?? 'auto-selected';
  const result: EvalTraceRunResult = {
    exampleId: `profile-feedback:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    task: options.prompt ? options.prompt.slice(0, 120) : 'validation profile feedback',
    status,
    expectedStatus: 'pass',
    actualStatus: status,
    tags: ['profile-feedback', `profile-feedback:${options.vote}`, options.profile, selectionSource],
    message: options.vote === 'up'
      ? `User confirmed ${options.profile} was a good auto-select.`
      : `User flagged ${options.profile} as a poor auto-select.`,
    links: options.selectionReason ? { context: options.selectionReason } : undefined,
  };
  return {
    id: `profile-feedback-run:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    total: 1,
    passed: status === 'pass' ? 1 : 0,
    failed: status === 'pass' ? 0 : 1,
    passRate: status === 'pass' ? 1 : 0,
    results: [result],
  };
}

export async function recordProfileFeedbackEvalRun(projectDir: string, options: ProfileFeedbackOptions): Promise<EvalTraceRun> {
  const run = createProfileFeedbackEvalRun(options);
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

/** Public wrapper around the internal append so external pipelines (e.g. the simulator) can persist runs into the same trend file the promotion gate consults. */
export async function persistEvalTraceRun(projectDir: string, run: EvalTraceRun): Promise<void> {
  return appendEvalTraceRun(projectDir, run);
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

export interface OutputValidationRunTrend {
  totalResults: number;
  byProfile: Record<string, { total: number; passed: number; failed: number; passRate: number }>;
  bySelectionSource: Record<string, { total: number; passed: number; failed: number; passRate: number }>;
  byStatus: Record<string, number>;
  latestFailures: Array<{ task: string; profile: string; status: string; selectionSource: string; message: string; checks: string[]; createdAt: string }>;
}

export interface OutputValidationTrendExport {
  generatedAt: string;
  trend: OutputValidationRunTrend;
  results: Array<{
    runId: string;
    createdAt: string;
    task: string;
    profile: string;
    status: string;
    selectionSource: string;
    passed: boolean;
    message: string;
    checks: string[];
  }>;
}

export function createOutputValidationTrendExport(runs: EvalTraceRun[], generatedAt = new Date().toISOString()): OutputValidationTrendExport {
  const results: OutputValidationTrendExport['results'] = [];
  for (const run of runs) {
    for (const result of run.results) {
      if (!result.tags.includes('output-validation')) continue;
      results.push({
        runId: run.id,
        createdAt: run.createdAt,
        task: result.task,
        profile: result.tags[1] ?? 'unknown',
        status: result.tags[2] ?? result.actualStatus,
        selectionSource: outputValidationSelectionSource(result.tags),
        passed: result.status === 'pass',
        message: result.message,
        checks: result.checks ?? [],
      });
    }
  }
  return { generatedAt, trend: summarizeOutputValidationRuns(runs), results };
}

export function summarizeOutputValidationRuns(runs: EvalTraceRun[]): OutputValidationRunTrend {
  const byProfile: OutputValidationRunTrend['byProfile'] = {};
  const bySelectionSource: OutputValidationRunTrend['bySelectionSource'] = {};
  const byStatus: OutputValidationRunTrend['byStatus'] = {};
  const latestFailures: OutputValidationRunTrend['latestFailures'] = [];
  let totalResults = 0;
  for (const run of runs) {
    for (const result of run.results) {
      if (!result.tags.includes('output-validation')) continue;
      totalResults++;
      const profile = result.tags[1] ?? 'unknown';
      const validationStatus = result.tags[2] ?? result.actualStatus;
      const selectionSource = outputValidationSelectionSource(result.tags);
      const bucket = byProfile[profile] ?? { total: 0, passed: 0, failed: 0, passRate: 0 };
      bucket.total++;
      if (result.status === 'pass') bucket.passed++;
      else bucket.failed++;
      bucket.passRate = rate(bucket.passed, bucket.total);
      byProfile[profile] = bucket;
      const sourceBucket = bySelectionSource[selectionSource] ?? { total: 0, passed: 0, failed: 0, passRate: 0 };
      sourceBucket.total++;
      if (result.status === 'pass') sourceBucket.passed++;
      else sourceBucket.failed++;
      sourceBucket.passRate = rate(sourceBucket.passed, sourceBucket.total);
      bySelectionSource[selectionSource] = sourceBucket;
      byStatus[validationStatus] = (byStatus[validationStatus] ?? 0) + 1;
      if (result.status === 'fail') {
        latestFailures.push({
          task: result.task,
          profile,
          status: validationStatus,
          selectionSource,
          message: result.message,
          checks: result.checks ?? [],
          createdAt: run.createdAt,
        });
      }
    }
  }
  return { totalResults, byProfile, bySelectionSource, byStatus, latestFailures: latestFailures.slice(-5).reverse() };
}

function outputValidationSelectionSource(tags: string[]): OutputValidationSelectionSource | 'unknown' {
  if (tags.includes('auto-selected')) return 'auto-selected';
  if (tags.includes('manual-selected')) return 'manual-selected';
  return 'unknown';
}

export interface ProfileFeedbackBucket {
  total: number;
  up: number;
  down: number;
  approvalRate: number;
}

export interface ProfileFeedbackInsight {
  profile: string;
  severity: 'info' | 'warn';
  message: string;
  downVotes: number;
  upVotes: number;
}

export interface ProfileFeedbackTrend {
  totalVotes: number;
  byProfile: Record<string, ProfileFeedbackBucket>;
  insights: ProfileFeedbackInsight[];
  recentVotes: Array<{ profile: string; vote: ProfileFeedbackVote; task: string; createdAt: string }>;
  dailyApproval: Array<{ date: string; total: number; up: number; down: number; approvalRate: number }>;
}

const PROFILE_FEEDBACK_DOWN_VOTE_WARN = 3;

export function summarizeProfileFeedbackRuns(runs: EvalTraceRun[]): ProfileFeedbackTrend {
  const byProfile: Record<string, ProfileFeedbackBucket> = {};
  const recentVotes: ProfileFeedbackTrend['recentVotes'] = [];
  const byDay = new Map<string, { total: number; up: number; down: number }>();
  let totalVotes = 0;
  for (const run of runs) {
    for (const result of run.results) {
      if (!result.tags.includes('profile-feedback')) continue;
      const vote: ProfileFeedbackVote = result.tags.includes('profile-feedback:down') ? 'down' : 'up';
      const profile = result.tags.find((tag) => tag !== 'profile-feedback'
        && tag !== 'profile-feedback:up'
        && tag !== 'profile-feedback:down'
        && tag !== 'auto-selected'
        && tag !== 'manual-selected') ?? 'unknown';
      totalVotes++;
      const bucket = byProfile[profile] ?? { total: 0, up: 0, down: 0, approvalRate: 0 };
      bucket.total++;
      if (vote === 'up') bucket.up++;
      else bucket.down++;
      bucket.approvalRate = rate(bucket.up, bucket.total);
      byProfile[profile] = bucket;
      recentVotes.push({ profile, vote, task: result.task, createdAt: run.createdAt });
      const day = (run.createdAt || '').slice(0, 10) || 'unknown';
      const dayBucket = byDay.get(day) ?? { total: 0, up: 0, down: 0 };
      dayBucket.total++;
      if (vote === 'up') dayBucket.up++; else dayBucket.down++;
      byDay.set(day, dayBucket);
    }
  }
  const insights: ProfileFeedbackInsight[] = [];
  for (const [profile, bucket] of Object.entries(byProfile)) {
    if (bucket.down >= PROFILE_FEEDBACK_DOWN_VOTE_WARN) {
      insights.push({
        profile,
        severity: 'warn',
        message: `${profile} accumulated ${bucket.down} down-votes (${bucket.up} up-votes). Review the auto-select keyword rules in docs/VALIDATION-PROFILES.md or add a custom profile that fits these prompts better.`,
        downVotes: bucket.down,
        upVotes: bucket.up,
      });
    } else if (bucket.down > 0 && bucket.up === 0) {
      insights.push({
        profile,
        severity: 'info',
        message: `${profile} has ${bucket.down} down-vote(s) and no up-votes yet. Keep collecting feedback before retuning.`,
        downVotes: bucket.down,
        upVotes: bucket.up,
      });
    }
  }
  return { totalVotes, byProfile, insights, recentVotes: recentVotes.slice(-5).reverse(), dailyApproval: Array.from(byDay.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, bucket]) => ({ date, total: bucket.total, up: bucket.up, down: bucket.down, approvalRate: rate(bucket.up, bucket.total) })) };
}