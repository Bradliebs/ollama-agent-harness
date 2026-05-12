import { formatSimulationSummary, runProbe, runSimulation, selectProbes, simulationRunToEvalTraceRun } from './simulator';
import { DEFAULT_PROBES, type ProbeDefinition } from './probes';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

function sseResponse(events: Array<Record<string, unknown>>, status = 200): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const baselineProbe: ProbeDefinition = DEFAULT_PROBES.find((probe) => probe.id === 'baseline.greeting')!;

describe('eval/simulator · selectProbes', () => {
  it('returns the full default set when no filters are passed', () => {
    expect(selectProbes({}).length).toBe(DEFAULT_PROBES.length);
  });

  it('honours filterIds', () => {
    const probes = selectProbes({ filterIds: ['baseline.greeting'] });
    expect(probes).toHaveLength(1);
    expect(probes[0].id).toBe('baseline.greeting');
  });

  it('honours filterCategories', () => {
    const probes = selectProbes({ filterCategories: ['secret-exfil'] });
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => probe.category === 'secret-exfil')).toBe(true);
  });
});

describe('eval/simulator · runProbe', () => {
  it('passes when the streamed response matches every expectation', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(sseResponse([
      { type: 'text', content: 'I am ' },
      { type: 'text', content: 'ready' },
      { type: 'done' },
    ])) as unknown as typeof fetch;
    const result = await runProbe(baselineProbe, { fetchImpl, baseUrl: 'http://daemon.example' });
    expect(result.status).toBe('pass');
    expect(result.responsePreview).toBe('I am ready');
  });

  it('fails when an expected substring is missing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(sseResponse([
      { type: 'text', content: 'sorry, no.' },
      { type: 'done' },
    ])) as unknown as typeof fetch;
    const result = await runProbe(baselineProbe, { fetchImpl, baseUrl: 'http://daemon.example' });
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/missing expected substring/);
  });

  it('fails when the assistant invokes a forbidden tool', async () => {
    const probe = DEFAULT_PROBES.find((p) => p.id === 'tool-misuse.rm-rf-root')!;
    const fetchImpl = jest.fn().mockResolvedValue(sseResponse([
      { type: 'tool_call', call: { name: 'bash' } },
      { type: 'text', content: 'I cannot help with that.' },
      { type: 'done' },
    ])) as unknown as typeof fetch;
    const result = await runProbe(probe, { fetchImpl, baseUrl: 'http://daemon.example' });
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/forbidden tool: bash/);
  });

  it('returns status=error when fetch throws', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const result = await runProbe(baselineProbe, { fetchImpl, baseUrl: 'http://daemon.example' });
    expect(result.status).toBe('error');
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });
});

describe('eval/simulator · runSimulation', () => {
  it('runs every selected probe and aggregates pass/fail counts', async () => {
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      // First probe passes, second fails (no expected substring).
      const text = call === 1 ? 'I am ready' : 'sorry, no';
      return sseResponse([
        { type: 'text', content: text },
        { type: 'done' },
      ]);
    }) as unknown as typeof fetch;
    const probes = [baselineProbe, { ...baselineProbe, id: 'baseline.second' }];
    const run = await runSimulation({ fetchImpl, baseUrl: 'http://daemon.example', probes });
    expect(run.total).toBe(2);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    expect(run.errored).toBe(0);
    expect(run.passRate).toBeCloseTo(0.5, 5);
  });

  it('reports zero counts cleanly when no probes are selected', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const run = await runSimulation({ fetchImpl, probes: [], baseUrl: 'http://daemon.example' });
    expect(run.total).toBe(0);
    expect(run.passRate).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('eval/simulator · formatSimulationSummary', () => {
  it('renders a one-screen text summary with per-probe lines', () => {
    const text = formatSimulationSummary({
      id: 'sim-1',
      startedAt: '2026-05-06T10:00:00.000Z',
      finishedAt: '2026-05-06T10:00:01.000Z',
      baseUrl: 'http://daemon.example',
      total: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      passRate: 0.5,
      results: [
        { probeId: 'baseline.greeting', category: 'baseline', status: 'pass', reason: 'ok', tags: [], responsePreview: '', toolCalls: [], durationMs: 12 },
        { probeId: 'injection.role-override', category: 'prompt-injection', status: 'fail', reason: 'banned substring', tags: [], responsePreview: '', toolCalls: [], durationMs: 25 },
      ],
    });
    expect(text).toContain('Simulation sim-1');
    expect(text).toContain('Pass rate: 50.0%');
    expect(text).toContain('✓ baseline.greeting');
    expect(text).toContain('✕ injection.role-override');
  });
});

describe('eval/simulator · simulationRunToEvalTraceRun', () => {
  it('maps probe results into EvalTraceRunResult shape', () => {
    const evalRun = simulationRunToEvalTraceRun({
      id: 'sim-1',
      startedAt: '2026-05-06T10:00:00.000Z',
      finishedAt: '2026-05-06T10:00:01.000Z',
      baseUrl: 'http://daemon.example',
      total: 3,
      passed: 1,
      failed: 1,
      errored: 1,
      passRate: 1 / 3,
      results: [
        { probeId: 'p1', category: 'baseline', status: 'pass', reason: 'ok', tags: ['baseline'], responsePreview: '', toolCalls: [], durationMs: 1 },
        { probeId: 'p2', category: 'prompt-injection', status: 'fail', reason: 'banned', tags: [], responsePreview: '', toolCalls: [], durationMs: 1 },
        { probeId: 'p3', category: 'tool-misuse', status: 'error', reason: 'timeout', tags: [], responsePreview: '', toolCalls: [], durationMs: 1 },
      ],
    });
    expect(evalRun.id).toBe('sim-1');
    expect(evalRun.total).toBe(3);
    // Errored probes are conservatively counted as failures.
    expect(evalRun.passed).toBe(1);
    expect(evalRun.failed).toBe(2);
    expect(evalRun.results.map((result) => result.status)).toEqual(['pass', 'fail', 'fail']);
    expect(evalRun.results[0].tags).toEqual(expect.arrayContaining(['simulator', 'baseline']));
  });
});

describe('eval/simulator · persistEvalRunProjectDir', () => {
  let projectDir: string;
  beforeEach(async () => { projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sim-')); });
  afterEach(async () => { await fs.rm(projectDir, { recursive: true, force: true }); });

  it('appends a JSONL EvalTraceRun under .harness/evals/trace-runs.jsonl when enabled', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('data: {"type":"text","content":"I am ready"}\n\ndata: {"type":"done"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    await runSimulation({
      fetchImpl,
      baseUrl: 'http://daemon.example',
      probes: [DEFAULT_PROBES.find((p) => p.id === 'baseline.greeting')!],
      persistEvalRunProjectDir: projectDir,
    });
    const fp = path.join(projectDir, '.harness', 'evals', 'trace-runs.jsonl');
    const raw = await fs.readFile(fp, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toMatch(/^sim-/);
    expect(parsed.results[0].tags).toEqual(expect.arrayContaining(['simulator']));
  });
});
