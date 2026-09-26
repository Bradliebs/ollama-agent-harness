import type { Message } from 'ollama';
import { queryLoop } from '../core/queryLoop';
import type { IChatClient } from '../core/chatClient';
import { CostTracker } from './costTracker';
import { RunLog, listRuns, readRunEvents, reconstructModelRequests, type RunEvent, type RunSummary } from '../persistence/runLog';
import type { Tool, ToolResult } from '../types';
import { stableArgsKey } from '../core/toolLoopGuards';
import { checkClaims } from '../verification/claimCheck';

export type ReplayMode = 'deterministic' | 'live';

export interface ReplayRecordedToolResult {
  name: string;
  input: Record<string, unknown>;
  key: string;
  success: boolean;
  output: string;
  error?: string;
  stepId?: string;
}

export interface ReplayToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ReplayMetrics {
  runId: string;
  model: string;
  doneReason: string;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  approximateToolMatches: number;
  missingToolResults: number;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
  durationMs: number;
  finalText: string;
  citedSources: number;
  /** Figure-bearing claims in the final answer, and how many appear in no page read (verification/claimCheck.ts). */
  checkedClaims: number;
  unsupportedClaims: number;
  supervisorInterventions: number;
  budgetExceeded: boolean;
  stuck: boolean;
  completed: boolean;
}

export interface ReplayCase {
  projectDir: string;
  originalRunId: string;
  systemPrompt: string;
  initialMessages: Message[];
  tools: ReplayToolDefinition[];
  toolResults: ReplayRecordedToolResult[];
  toolResultsByKey: Record<string, ReplayRecordedToolResult[]>;
  originalMetrics: ReplayMetrics;
}

export interface ReplayRunOptions {
  client: IChatClient;
  model: string;
  maxTurns?: number;
  signal?: AbortSignal;
  mode?: ReplayMode;
  tools?: Tool[];
  /**
   * Deterministic mode: real tool definitions whose names match recorded
   * tools lend their description and parameter schema to the replay stubs,
   * so the model sees the same tool surface as the original run. Their
   * execute functions are never called.
   */
  schemaTools?: Tool[];
  now?: Date;
}

export interface ReplayRunResult {
  runId: string;
  mode: ReplayMode;
  metrics: ReplayMetrics;
}

export interface ReplayComparisonReport {
  original: ReplayMetrics;
  replays: ReplayMetrics[];
  rows: Array<ReplayMetrics & {
    label: string;
    turnsDelta: number;
    tokenDelta: number;
    costDelta: number;
    durationDeltaMs: number;
  }>;
}

export interface BenchmarkHistoryOptions {
  models: string[];
  lastN: number;
  filter?: (summary: RunSummary, events: RunEvent[]) => boolean;
  createClient: (model: string, replayCase: ReplayCase) => IChatClient | Promise<IChatClient>;
  maxTurns?: number;
  signal?: AbortSignal;
  concurrency?: number;
  /** Real tool definitions lending schemas to the deterministic stubs. */
  schemaTools?: Tool[];
}

export interface BenchmarkHistoryRow {
  originalRunId: string;
  replayRunId: string;
  model: string;
  completed: boolean;
  doneReason: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
  durationMs: number;
  citedSources: number;
  checkedClaims: number;
  unsupportedClaims: number;
  stuck: boolean;
}

export interface BenchmarkHistoryAggregate {
  model: string;
  runs: number;
  completionRate: number;
  avgTurns: number;
  avgTokens: number;
  avgCost: number;
  avgDurationMs: number;
  stuckRate: number;
  avgCitedSources: number;
  /** Share of checked claims not supported by any page read, across the model's runs. */
  unsupportedClaimRate: number;
}

export interface BenchmarkHistoryReport {
  selectedRunIds: string[];
  skippedRunIds: string[];
  rows: BenchmarkHistoryRow[];
  aggregates: BenchmarkHistoryAggregate[];
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;
const RESEARCH_TOOL_NAMES = new Set(['web_read', 'web_fetch', 'web_search', 'browser_read']);

export async function loadReplayCase(projectDir: string, runId: string): Promise<ReplayCase> {
  const events = await readRunEvents(projectDir, runId);
  if (events.length === 0) throw new Error(`Run not found: ${runId}`);
  if (!events.some((event) => event.kind === 'run_end')) throw new Error(`Run log is incomplete: ${runId}`);

  const requests = reconstructModelRequests(events);
  if (requests.length === 0) throw new Error(`Run has no model requests: ${runId}`);
  const firstMessages = requests[0].messages;
  const systemIndex = firstMessages.findIndex((message) => message.role === 'system');
  const systemPrompt = systemIndex >= 0 && typeof firstMessages[systemIndex].content === 'string'
    ? firstMessages[systemIndex].content
    : '';
  const firstAssistant = firstMessages.findIndex((message) => message.role === 'assistant');
  const taskBoundary = firstAssistant >= 0 ? firstAssistant : firstMessages.length;
  let lastUserBeforeAssistant = -1;
  for (let index = 0; index < taskBoundary; index += 1) {
    if (firstMessages[index].role === 'user') lastUserBeforeAssistant = index;
  }
  const initialMessages = firstMessages
    .slice(0, lastUserBeforeAssistant >= 0 ? lastUserBeforeAssistant + 1 : taskBoundary)
    .filter((message, index) => !(index === systemIndex && message.role === 'system'));

  const toolDefinitions = orderedToolDefinitions(events);
  const toolResults = extractRecordedToolResults(events);
  const toolResultsByKey: Record<string, ReplayRecordedToolResult[]> = {};
  for (const result of toolResults) {
    toolResultsByKey[result.key] = [...(toolResultsByKey[result.key] ?? []), result];
  }

  return {
    projectDir,
    originalRunId: runId,
    systemPrompt,
    initialMessages,
    tools: toolDefinitions,
    toolResults,
    toolResultsByKey,
    originalMetrics: metricsFromEvents(runId, events, { approximateToolMatches: 0, missingToolResults: 0 }),
  };
}

export async function replayRun(replayCase: ReplayCase, options: ReplayRunOptions): Promise<ReplayRunResult> {
  const mode = options.mode ?? 'deterministic';
  const counters = { approximateToolMatches: 0, missingToolResults: 0 };
  const tools = mode === 'live'
    ? (options.tools ?? [])
    : createReplayStubTools(replayCase, counters, options.schemaTools);
  const runId = makeReplayRunId(replayCase.originalRunId, options.model, options.now ?? new Date());
  const runLog = new RunLog(replayCase.projectDir, runId);
  for await (const _event of queryLoop(
    {
      model: options.model,
      systemPrompt: replayCase.systemPrompt,
      maxTurns: options.maxTurns ?? Math.max(3, replayCase.originalMetrics.turns + 2),
      abortSignal: options.signal,
      context: { enabled: false },
      verify: { enabled: false },
      supervisor: false,
    },
    { client: options.client, tools, runLog },
    replayCase.initialMessages,
  )) {
    // Consume the stream so queryLoop reaches run_end and flushes the replay log.
  }
  await runLog.flush();
  const events = await readRunEvents(replayCase.projectDir, runId);
  return {
    runId,
    mode,
    metrics: metricsFromEvents(runId, events, counters),
  };
}

export function compareRuns(original: ReplayMetrics, replays: ReplayMetrics[]): ReplayComparisonReport {
  const originalTokens = original.promptTokens + original.completionTokens;
  return {
    original,
    replays,
    rows: replays.map((replay) => ({
      ...replay,
      label: replay.model,
      turnsDelta: replay.turns - original.turns,
      tokenDelta: replay.promptTokens + replay.completionTokens - originalTokens,
      costDelta: round6(replay.estimatedUsd - original.estimatedUsd),
      durationDeltaMs: replay.durationMs - original.durationMs,
    })),
  };
}

export function formatReportTable(report: ReplayComparisonReport): string {
  const rows = [report.original, ...report.replays];
  const data = rows.map((row, index) => ([
    index === 0 ? 'original' : row.model,
    row.doneReason,
    String(row.turns),
    String(row.toolCalls),
    `${row.promptTokens + row.completionTokens}`,
    `$${row.estimatedUsd.toFixed(6)}`,
    `${row.durationMs}ms`,
    String(row.citedSources),
    row.checkedClaims ? `${row.unsupportedClaims}/${row.checkedClaims}` : '-',
    row.completed ? 'yes' : 'no',
    row.approximateToolMatches ? String(row.approximateToolMatches) : '-',
    row.missingToolResults ? String(row.missingToolResults) : '-',
  ]));
  return renderTable(['run', 'done', 'turns', 'tools', 'tokens', 'cost', 'duration', 'urls', 'unsupported', 'completed', 'approx', 'missing'], data);
}

export function formatReportMarkdown(report: ReplayComparisonReport): string {
  const header = '| Run | Done | Turns | Tool calls | Tokens | Cost USD | Duration ms | URLs | Unsupported claims | Completed | Approx | Missing |';
  const sep = '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |';
  const rows = [report.original, ...report.replays].map((row, index) => {
    const label = index === 0 ? 'original' : row.model;
    return `| ${escapeMd(label)} | ${escapeMd(row.doneReason)} | ${row.turns} | ${row.toolCalls} | ${row.promptTokens + row.completionTokens} | ${row.estimatedUsd.toFixed(6)} | ${row.durationMs} | ${row.citedSources} | ${row.checkedClaims ? `${row.unsupportedClaims}/${row.checkedClaims}` : '-'} | ${row.completed ? 'yes' : 'no'} | ${row.approximateToolMatches} | ${row.missingToolResults} |`;
  });
  return [header, sep, ...rows].join('\n');
}

export async function benchmarkHistory(projectDir: string, options: BenchmarkHistoryOptions): Promise<BenchmarkHistoryReport> {
  const limit = Math.max(options.lastN * 5, options.lastN, 10);
  const summaries = await listRuns(projectDir, limit);
  const selected: ReplayCase[] = [];
  const skippedRunIds: string[] = [];
  for (const summary of summaries) {
    if (selected.length >= options.lastN) break;
    if (!summary.runId.startsWith('chat-')) continue;
    const events = await readRunEvents(projectDir, summary.runId);
    if (!events.some((event) => event.kind === 'run_end')) { skippedRunIds.push(summary.runId); continue; }
    const metrics = metricsFromEvents(summary.runId, events, { approximateToolMatches: 0, missingToolResults: 0 });
    if (!metrics.completed || metrics.toolCalls < 1) continue;
    if (options.filter && !options.filter(summary, events)) continue;
    try {
      selected.push(await loadReplayCase(projectDir, summary.runId));
    } catch {
      skippedRunIds.push(summary.runId);
    }
  }

  const rows: BenchmarkHistoryRow[] = [];
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  if (concurrency !== 1) {
    // Keep the current implementation deterministic and side-effect-free; callers can
    // request >1 later without changing the public shape, but Phase 10 defaults to 1.
  }
  for (const replayCase of selected) {
    for (const model of options.models) {
      if (options.signal?.aborted) throw new Error('Benchmark aborted');
      const client = await options.createClient(model, replayCase);
      const replay = await replayRun(replayCase, { client, model, maxTurns: options.maxTurns, signal: options.signal, schemaTools: options.schemaTools });
      rows.push({
        originalRunId: replayCase.originalRunId,
        replayRunId: replay.runId,
        model,
        completed: replay.metrics.completed,
        doneReason: replay.metrics.doneReason,
        turns: replay.metrics.turns,
        promptTokens: replay.metrics.promptTokens,
        completionTokens: replay.metrics.completionTokens,
        estimatedUsd: replay.metrics.estimatedUsd,
        durationMs: replay.metrics.durationMs,
        citedSources: replay.metrics.citedSources,
        checkedClaims: replay.metrics.checkedClaims,
        unsupportedClaims: replay.metrics.unsupportedClaims,
        stuck: replay.metrics.stuck,
      });
    }
  }

  const aggregates = options.models.map((model) => aggregateRows(model, rows.filter((row) => row.model === model)));
  return { selectedRunIds: selected.map((entry) => entry.originalRunId), skippedRunIds, rows, aggregates };
}

function createReplayStubTools(replayCase: ReplayCase, counters: { approximateToolMatches: number; missingToolResults: number }, schemaTools: Tool[] = []): Tool[] {
  const records = replayCase.toolResults.map((entry) => ({ ...entry, used: false }));
  const schemas = new Map(schemaTools.map((tool) => [tool.name, tool]));
  return replayCase.tools.map((tool) => ({
    name: tool.name,
    description: schemas.get(tool.name)?.description ?? tool.description,
    parameters: schemas.get(tool.name)?.parameters ?? tool.parameters,
    isReadOnly: true,
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const key = makeToolKey(tool.name, input);
      const exact = records.find((record) => !record.used && record.key === key);
      if (exact) {
        exact.used = true;
        return toToolResult(exact);
      }
      const approximate = records.find((record) => !record.used && record.name === tool.name);
      if (approximate) {
        approximate.used = true;
        counters.approximateToolMatches += 1;
        return toToolResult(approximate);
      }
      counters.missingToolResults += 1;
      return { success: false, output: 'No recorded result for this call in the original run (replay mode)', error: 'missing replay tool result' };
    },
  }));
}

function toToolResult(record: ReplayRecordedToolResult): ToolResult {
  return { success: record.success, output: record.output, ...(record.error ? { error: record.error } : {}) };
}

function extractRecordedToolResults(events: readonly RunEvent[]): ReplayRecordedToolResult[] {
  const callsByStep = new Map<string, { name: string; input: Record<string, unknown> }>();
  const fallbackCalls: Array<{ name: string; input: Record<string, unknown>; used: boolean }> = [];
  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    const name = String(event.data.name ?? '');
    const input = isRecord(event.data.input) ? event.data.input : {};
    if (event.stepId) callsByStep.set(event.stepId, { name, input });
    fallbackCalls.push({ name, input, used: false });
  }

  const results: ReplayRecordedToolResult[] = [];
  for (const event of events) {
    if (event.kind !== 'tool_result') continue;
    const name = String(event.data.name ?? '');
    let call = event.stepId ? callsByStep.get(event.stepId) : undefined;
    if (!call) {
      const fallback = fallbackCalls.find((entry) => !entry.used && entry.name === name) ?? fallbackCalls.find((entry) => !entry.used);
      if (fallback) {
        fallback.used = true;
        call = fallback;
      }
    }
    const input = call?.input ?? {};
    results.push({
      name,
      input,
      key: makeToolKey(name, input),
      success: event.data.success !== false,
      output: stringifyOutput(event.data.output),
      error: typeof event.data.error === 'string' ? event.data.error : undefined,
      stepId: event.stepId,
    });
  }
  return results;
}

function orderedToolDefinitions(events: readonly RunEvent[]): ReplayToolDefinition[] {
  const tools = new Map<string, ReplayToolDefinition>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value && !tools.has(value)) {
      tools.set(value, {
        name: value,
        description: `Replay stub for recorded tool ${value}`,
        parameters: { type: 'object', additionalProperties: true },
      });
      return;
    }
    if (isRecord(value) && isRecord(value.function) && typeof value.function.name === 'string' && !tools.has(value.function.name)) {
      tools.set(value.function.name, {
        name: value.function.name,
        description: typeof value.function.description === 'string' ? value.function.description : `Replay stub for recorded tool ${value.function.name}`,
        parameters: isRecord(value.function.parameters) ? value.function.parameters : { type: 'object', additionalProperties: true },
      });
    }
  };
  for (const event of events) {
    if (event.kind === 'run_start' && Array.isArray(event.data.tools)) event.data.tools.forEach(add);
    if (event.kind === 'model_request' && Array.isArray(event.data.tools)) event.data.tools.forEach(add);
    if (event.kind === 'tool_call') add(event.data.name);
  }
  return [...tools.values()];
}

function metricsFromEvents(runId: string, events: readonly RunEvent[], replayCounters: { approximateToolMatches: number; missingToolResults: number }): ReplayMetrics {
  const start = events.find((event) => event.kind === 'run_start');
  const end = [...events].reverse().find((event) => event.kind === 'run_end');
  const model = String(end?.data.model ?? start?.data.model ?? modelFromResponses(events) ?? 'unknown');
  const doneReason = String(end?.data.reason ?? 'incomplete');
  const turns = typeof end?.data.turns === 'number' ? end.data.turns : events.filter((event) => event.kind === 'model_request').length;
  let promptTokens = 0;
  let completionTokens = 0;
  const tracker = new CostTracker(model);
  let costTurn = 0;
  let finalText = '';
  for (const event of events) {
    if (event.kind !== 'model_response') continue;
    const usage = isRecord(event.data.usage) ? event.data.usage : undefined;
    const inTokens = numberValue(usage?.promptTokens);
    const outTokens = numberValue(usage?.completionTokens);
    promptTokens += inTokens;
    completionTokens += outTokens;
    costTurn += 1;
    tracker.recordTurn(costTurn, inTokens, outTokens);
    const message = isRecord(event.data.message) ? event.data.message : undefined;
    const toolCalls = Array.isArray(message?.tool_calls) ? message?.tool_calls : [];
    if (toolCalls.length === 0 && typeof message?.content === 'string') finalText = message.content;
  }
  const durationMs = start && end ? Math.max(0, Date.parse(end.ts) - Date.parse(start.ts)) : 0;
  const supervisorEvents = events.filter((event) => event.kind === 'supervisor');
  const pagesRead = events
    .filter((event) => event.kind === 'tool_result' && event.data.success === true && RESEARCH_TOOL_NAMES.has(String(event.data.name)) && typeof event.data.output === 'string')
    .map((event) => String(event.data.output));
  const userText = events
    .filter((event) => event.kind === 'messages')
    .flatMap((event) => (Array.isArray(event.data.messages) ? event.data.messages : []))
    .filter((message): message is Message => isRecord(message) && message.role === 'user' && typeof message.content === 'string')
    .map((message) => String(message.content));
  const claims = pagesRead.length > 0 && finalText ? checkClaims(finalText, pagesRead, userText) : null;
  return {
    runId,
    model,
    doneReason,
    turns,
    toolCalls: events.filter((event) => event.kind === 'tool_call').length,
    toolFailures: events.filter((event) => event.kind === 'tool_result' && event.data.success === false).length,
    approximateToolMatches: replayCounters.approximateToolMatches,
    missingToolResults: replayCounters.missingToolResults,
    promptTokens,
    completionTokens,
    estimatedUsd: tracker.summarize().totalEstimatedCostUsd,
    durationMs,
    finalText,
    citedSources: (finalText.match(URL_PATTERN) ?? []).length,
    checkedClaims: claims?.checked.length ?? 0,
    unsupportedClaims: claims?.unsupported.length ?? 0,
    supervisorInterventions: supervisorEvents.filter((event) => event.data.event === 'intervene' || event.data.stage).length,
    budgetExceeded: supervisorEvents.some((event) => event.data.event === 'budget_exceeded') || doneReason === 'budget_synthesized',
    stuck: doneReason === 'stuck_needs_human',
    completed: doneReason.startsWith('completed'),
  };
}

function aggregateRows(model: string, rows: BenchmarkHistoryRow[]): BenchmarkHistoryAggregate {
  const count = rows.length;
  const avg = (selector: (row: BenchmarkHistoryRow) => number): number => count === 0 ? 0 : round6(rows.reduce((sum, row) => sum + selector(row), 0) / count);
  return {
    model,
    runs: count,
    completionRate: count === 0 ? 0 : round6(rows.filter((row) => row.completed).length / count),
    avgTurns: avg((row) => row.turns),
    avgTokens: avg((row) => row.promptTokens + row.completionTokens),
    avgCost: avg((row) => row.estimatedUsd),
    avgDurationMs: avg((row) => row.durationMs),
    stuckRate: count === 0 ? 0 : round6(rows.filter((row) => row.stuck).length / count),
    avgCitedSources: avg((row) => row.citedSources),
    unsupportedClaimRate: (() => {
      const checked = rows.reduce((sum, row) => sum + row.checkedClaims, 0);
      return checked === 0 ? 0 : round6(rows.reduce((sum, row) => sum + row.unsupportedClaims, 0) / checked);
    })(),
  };
}

function makeToolKey(name: string, input: Record<string, unknown>): string {
  return `${name}|${stableArgsKey(input)}`;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try { return JSON.stringify(output); } catch { return String(output); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function modelFromResponses(events: readonly RunEvent[]): string | undefined {
  const response = events.find((event) => event.kind === 'model_response' && typeof event.data.model === 'string');
  return response?.data.model as string | undefined;
}

function safeRunPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 48) || 'model';
}

function makeReplayRunId(originalRunId: string, model: string, now: Date): string {
  const suffix = `${safeRunPart(model)}-${stamp(now)}`;
  const originalBudget = Math.max(8, 160 - 'replay--'.length - suffix.length);
  return `replay-${safeRunPart(originalRunId).slice(0, originalBudget)}-${suffix}`;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const render = (row: string[]): string => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [render(headers), render(widths.map((width) => '-'.repeat(width))), ...rows.map(render)].join('\n');
}

function escapeMd(value: string): string {
  return value.replace(/\|/g, '\\|');
}
