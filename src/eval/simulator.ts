// Simulation harness.
//
// Drives a running Harness daemon over its /api/chat SSE endpoint with
// scripted probes. For each probe it captures the assistant text and the
// tool-call sequence, then judges with the pure verdict function from
// `probes.ts`. Outputs a structured run record that the eval/promotion
// pipeline can ingest like any other EvalTraceRun.
//
// Designed for unit-testability: HTTP transport is injected via
// `fetchImpl`, so tests stub the daemon entirely.

import { DEFAULT_PROBES, judgeProbe, type ProbeDefinition, type ProbeVerdict } from './probes';
import type { EvalTraceRun, EvalTraceRunResult } from '../learning/evalTrace';
import { persistEvalTraceRun } from '../learning/evalTrace';

export interface SimulatorOptions {
  /** Daemon base URL. Default http://127.0.0.1:4300. */
  baseUrl?: string;
  /** Optional model id to send with every chat request. */
  model?: string;
  /** Override fetch (mainly for tests). */
  fetchImpl?: typeof fetch;
  /** Probe set; defaults to DEFAULT_PROBES. */
  probes?: ProbeDefinition[];
  /** Probe ids to include; when empty, run all. */
  filterIds?: string[];
  /** Probe categories to include; when empty, run all. */
  filterCategories?: ProbeDefinition['category'][];
  /** Per-probe wall-clock cap in ms. Defaults to 60_000. */
  perProbeTimeoutMs?: number;
  /** When set, the simulator persists a converted EvalTraceRun under this project dir so the promotion gate can consume it. */
  persistEvalRunProjectDir?: string;
}

export interface ProbeResult {
  probeId: string;
  category: ProbeDefinition['category'];
  status: 'pass' | 'fail' | 'error';
  reason: string;
  tags: string[];
  responsePreview: string;
  toolCalls: string[];
  durationMs: number;
}

export interface SimulationRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  model?: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  results: ProbeResult[];
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:4300';
const DEFAULT_TIMEOUT_MS = 60_000;

export function selectProbes(options: SimulatorOptions): ProbeDefinition[] {
  let probes = (options.probes ?? DEFAULT_PROBES).slice();
  if (options.filterIds && options.filterIds.length > 0) {
    const allow = new Set(options.filterIds);
    probes = probes.filter((probe) => allow.has(probe.id));
  }
  if (options.filterCategories && options.filterCategories.length > 0) {
    const allow = new Set(options.filterCategories);
    probes = probes.filter((probe) => allow.has(probe.category));
  }
  return probes;
}

interface SseStreamObservation {
  responseText: string;
  toolCalls: string[];
}

/**
 * Read one /api/chat SSE response into a flattened observation.
 * Resolves on the `done` event, on stream end, or when `timeoutMs` ms
 * elapse with no further data.
 */
async function consumeChatStream(response: Response, timeoutMs: number): Promise<SseStreamObservation> {
  if (!response.ok || !response.body) {
    throw new Error(`/api/chat returned ${response.status}`);
  }
  const reader = (response.body as unknown as { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } }).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseText = '';
  const toolCalls: string[] = [];
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
      if (payloadText === '[DONE]') return { responseText, toolCalls };
      try {
        const event = JSON.parse(payloadText) as { type?: string; content?: string; call?: { name?: string } };
        if (event.type === 'text' && typeof event.content === 'string') responseText += event.content;
        else if (event.type === 'tool_call' && event.call?.name) toolCalls.push(event.call.name);
        else if (event.type === 'done') return { responseText, toolCalls };
      } catch { /* skip malformed lines */ }
    }
  }
  return { responseText, toolCalls };
}

/**
 * Run a single probe against the daemon and judge the response.
 */
export async function runProbe(probe: ProbeDefinition, options: SimulatorOptions = {}): Promise<ProbeResult> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.perProbeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!fetchImpl) {
    return {
      probeId: probe.id,
      category: probe.category,
      status: 'error',
      reason: 'global fetch unavailable',
      tags: probe.tags ?? [],
      responsePreview: '',
      toolCalls: [],
      durationMs: 0,
    };
  }
  const startedAt = Date.now();
  let observation: SseStreamObservation;
  try {
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message: probe.input, model: options.model }),
    });
    observation = await consumeChatStream(response, timeoutMs);
  } catch (error) {
    return {
      probeId: probe.id,
      category: probe.category,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      tags: probe.tags ?? [],
      responsePreview: '',
      toolCalls: [],
      durationMs: Date.now() - startedAt,
    };
  }
  const verdict: ProbeVerdict = judgeProbe(probe, { response: observation.responseText, toolCalls: observation.toolCalls });
  return {
    probeId: probe.id,
    category: probe.category,
    status: verdict.status,
    reason: verdict.reason,
    tags: probe.tags ?? [],
    responsePreview: observation.responseText.slice(0, 200),
    toolCalls: observation.toolCalls,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run every selected probe sequentially. Probes intentionally run one
 * at a time so a slow daemon does not pile up streams.
 */
export async function runSimulation(options: SimulatorOptions = {}): Promise<SimulationRun> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const probes = selectProbes(options);
  const results: ProbeResult[] = [];
  const startedAt = new Date();
  for (const probe of probes) {
    results.push(await runProbe(probe, options));
  }
  const finishedAt = new Date();
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const errored = results.filter((result) => result.status === 'error').length;
  const run: SimulationRun = {
    id: `sim-${startedAt.getTime()}`,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    baseUrl,
    model: options.model,
    total: results.length,
    passed,
    failed,
    errored,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };
  if (options.persistEvalRunProjectDir) {
    await persistEvalTraceRun(options.persistEvalRunProjectDir, simulationRunToEvalTraceRun(run)).catch(() => { /* best-effort */ });
  }
  return run;
}

/**
 * Convert a SimulationRun into the EvalTraceRun shape the promotion
 * gate counts. Errored probes are mapped to `fail` so the gate stays
 * conservative — a daemon that cannot answer adversarial probes does
 * NOT count as a pass.
 */
export function simulationRunToEvalTraceRun(run: SimulationRun): EvalTraceRun {
  const results: EvalTraceRunResult[] = run.results.map((probe) => ({
    exampleId: probe.probeId,
    task: probe.category,
    status: probe.status === 'pass' ? 'pass' : 'fail',
    expectedStatus: 'pass',
    actualStatus: probe.status === 'pass' ? 'pass' : 'fail',
    tags: ['simulator', probe.category, ...probe.tags],
    message: probe.reason,
  }));
  return {
    id: run.id,
    createdAt: run.startedAt,
    total: results.length,
    passed: run.passed,
    failed: run.failed + run.errored,
    passRate: run.passRate,
    results,
  };
}

/**
 * Format a SimulationRun as a one-screen text summary suitable for the
 * CLI. Pure — no console writes.
 */
export function formatSimulationSummary(run: SimulationRun): string {
  const lines: string[] = [];
  lines.push(`Simulation ${run.id}`);
  lines.push(`  Base URL: ${run.baseUrl}${run.model ? `  ·  model: ${run.model}` : ''}`);
  lines.push(`  Probes: ${run.total}  ·  pass: ${run.passed}  ·  fail: ${run.failed}  ·  error: ${run.errored}`);
  lines.push(`  Pass rate: ${(run.passRate * 100).toFixed(1)}%`);
  for (const result of run.results) {
    const icon = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✕' : '!';
    lines.push(`  ${icon} ${result.probeId.padEnd(36)} ${result.status.toUpperCase().padEnd(6)} ${result.reason}`);
  }
  return lines.join('\n');
}
