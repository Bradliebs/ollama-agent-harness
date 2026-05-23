import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  GoldenTrace,
  DriftResult,
  saveGoldenTrace,
  loadGoldenTrace,
  listGoldenTraces,
  deleteGoldenTrace,
  compareWithGolden,
  captureFromRun,
  renderDriftReport,
} from './goldenTraces';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTrace(overrides: Partial<GoldenTrace> = {}): GoldenTrace {
  return {
    id: 'test-trace-1',
    name: 'test-trace',
    capturedAt: '2025-01-01T00:00:00.000Z',
    model: 'test-model',
    input: 'fix the bug',
    expectedOutput: 'I fixed the bug in main.ts',
    expectedToolCalls: ['readFile', 'editFile', 'runTests'],
    expectedFiles: ['src/main.ts', 'src/utils.ts'],
    tags: ['regression'],
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'golden-traces-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── saveGoldenTrace + loadGoldenTrace ───────────────────────────────

describe('saveGoldenTrace + loadGoldenTrace', () => {
  it('round-trips a trace through save and load', async () => {
    const trace = makeTrace();
    await saveGoldenTrace(tmpDir, trace);
    const loaded = await loadGoldenTrace(tmpDir, trace.id);
    expect(loaded).toEqual(trace);
  });

  it('persists as indented JSON', async () => {
    const trace = makeTrace();
    await saveGoldenTrace(tmpDir, trace);
    const raw = await fs.readFile(
      path.join(tmpDir, '.harness/golden-traces', `${trace.id}.json`),
      'utf-8',
    );
    expect(raw).toBe(JSON.stringify(trace, null, 2));
  });

  it('overwrites an existing trace with the same id', async () => {
    const trace = makeTrace();
    await saveGoldenTrace(tmpDir, trace);
    const updated = makeTrace({ name: 'updated-name' });
    await saveGoldenTrace(tmpDir, updated);
    const loaded = await loadGoldenTrace(tmpDir, trace.id);
    expect(loaded?.name).toBe('updated-name');
  });
});

// ─── loadGoldenTrace ─────────────────────────────────────────────────

describe('loadGoldenTrace', () => {
  it('returns undefined for a missing trace', async () => {
    const result = await loadGoldenTrace(tmpDir, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('returns undefined when directory does not exist', async () => {
    const result = await loadGoldenTrace(path.join(tmpDir, 'no-such-dir'), 'id');
    expect(result).toBeUndefined();
  });
});

// ─── listGoldenTraces ────────────────────────────────────────────────

describe('listGoldenTraces', () => {
  it('lists multiple traces', async () => {
    const t1 = makeTrace({ id: 'trace-a', name: 'alpha' });
    const t2 = makeTrace({ id: 'trace-b', name: 'beta' });
    await saveGoldenTrace(tmpDir, t1);
    await saveGoldenTrace(tmpDir, t2);

    const traces = await listGoldenTraces(tmpDir);
    const ids = traces.map(t => t.id).sort();
    expect(ids).toEqual(['trace-a', 'trace-b']);
  });

  it('returns empty array when directory does not exist', async () => {
    const result = await listGoldenTraces(path.join(tmpDir, 'missing'));
    expect(result).toEqual([]);
  });

  it('returns empty array when directory is empty', async () => {
    const dir = path.join(tmpDir, '.harness/golden-traces');
    await fs.mkdir(dir, { recursive: true });
    const result = await listGoldenTraces(tmpDir);
    expect(result).toEqual([]);
  });
});

// ─── deleteGoldenTrace ───────────────────────────────────────────────

describe('deleteGoldenTrace', () => {
  it('removes a trace and returns true', async () => {
    const trace = makeTrace();
    await saveGoldenTrace(tmpDir, trace);
    const deleted = await deleteGoldenTrace(tmpDir, trace.id);
    expect(deleted).toBe(true);
    const loaded = await loadGoldenTrace(tmpDir, trace.id);
    expect(loaded).toBeUndefined();
  });

  it('returns false for a missing trace', async () => {
    const deleted = await deleteGoldenTrace(tmpDir, 'nonexistent');
    expect(deleted).toBe(false);
  });
});

// ─── compareWithGolden ───────────────────────────────────────────────

describe('compareWithGolden', () => {
  it('perfect match yields similarity 1.0 and severity none', () => {
    const trace = makeTrace();
    const result = compareWithGolden(trace, {
      output: trace.expectedOutput,
      toolCalls: [...trace.expectedToolCalls],
      files: [...trace.expectedFiles],
    });
    expect(result.similarity).toBe(1.0);
    expect(result.severity).toBe('none');
    expect(result.diffs).toHaveLength(0);
  });

  it('completely different yields severity critical', () => {
    const trace = makeTrace();
    const result = compareWithGolden(trace, {
      output: 'something entirely unrelated xyz abc',
      toolCalls: ['unknownTool'],
      files: ['other/file.js'],
    });
    expect(result.severity).toBe('critical');
    expect(result.similarity).toBeLessThan(0.5);
  });

  it('minor drift with small output change', () => {
    const trace = makeTrace({
      expectedOutput: 'a b c d e f g h i j',
      expectedToolCalls: ['readFile', 'editFile'],
      expectedFiles: ['a.ts'],
    });
    const result = compareWithGolden(trace, {
      // 8 of 10 tokens shared → Jaccard 8/12=0.667, overall 0.5*0.667+0.5=0.833
      output: 'a b c d e f g h k l',
      toolCalls: ['readFile', 'editFile'],
      files: ['a.ts'],
    });
    expect(result.severity).toBe('minor');
    expect(result.similarity).toBeGreaterThanOrEqual(0.8);
    expect(result.similarity).toBeLessThan(0.95);
  });

  it('major drift with moderate differences', () => {
    const trace = makeTrace({
      expectedOutput: 'a b c d e f g h i j',
      expectedToolCalls: ['t1', 't2', 't3', 't4'],
      expectedFiles: ['a.ts', 'b.ts'],
    });
    const result = compareWithGolden(trace, {
      // output: 6/14≈0.429, tools: 3/4=0.75, files: 1/3≈0.333
      // overall: 0.5*0.429 + 0.3*0.75 + 0.2*0.333 ≈ 0.506
      output: 'a b c d e f x y z w',
      toolCalls: ['t1', 't2', 't3', 'x'],
      files: ['a.ts', 'c.ts'],
    });
    expect(result.severity).toBe('major');
    expect(result.similarity).toBeGreaterThanOrEqual(0.5);
    expect(result.similarity).toBeLessThan(0.8);
  });

  it('empty expected vs non-empty actual', () => {
    const trace = makeTrace({
      expectedOutput: '',
      expectedToolCalls: [],
      expectedFiles: [],
    });
    const result = compareWithGolden(trace, {
      output: 'some output here',
      toolCalls: ['tool1'],
      files: ['file.ts'],
    });
    expect(result.similarity).toBeLessThan(1.0);
    expect(result.diffs.length).toBeGreaterThan(0);
  });

  it('both empty yields perfect similarity', () => {
    const trace = makeTrace({
      expectedOutput: '',
      expectedToolCalls: [],
      expectedFiles: [],
    });
    const result = compareWithGolden(trace, {
      output: '',
      toolCalls: [],
      files: [],
    });
    expect(result.similarity).toBe(1.0);
    expect(result.severity).toBe('none');
  });

  it('tool call order matters', () => {
    const trace = makeTrace({
      expectedToolCalls: ['a', 'b', 'c'],
    });
    const result = compareWithGolden(trace, {
      output: trace.expectedOutput,
      toolCalls: ['c', 'b', 'a'],
      files: [...trace.expectedFiles],
    });
    expect(result.diffs.some(d => d.field === 'tool_calls')).toBe(true);
  });

  it('extra tool calls reduce similarity', () => {
    const trace = makeTrace({
      expectedToolCalls: ['a', 'b'],
    });
    const result = compareWithGolden(trace, {
      output: trace.expectedOutput,
      toolCalls: ['a', 'b', 'c', 'd'],
      files: [...trace.expectedFiles],
    });
    const toolDiff = result.diffs.find(d => d.field === 'tool_calls');
    expect(toolDiff).toBeDefined();
    expect(result.similarity).toBeLessThan(1.0);
  });

  it('missing tool calls reduce similarity', () => {
    const trace = makeTrace({
      expectedToolCalls: ['a', 'b', 'c', 'd'],
    });
    const result = compareWithGolden(trace, {
      output: trace.expectedOutput,
      toolCalls: ['a', 'b'],
      files: [...trace.expectedFiles],
    });
    const toolDiff = result.diffs.find(d => d.field === 'tool_calls');
    expect(toolDiff).toBeDefined();
  });

  it('file differences are detected', () => {
    const trace = makeTrace({
      expectedFiles: ['a.ts', 'b.ts', 'c.ts'],
    });
    const result = compareWithGolden(trace, {
      output: trace.expectedOutput,
      toolCalls: [...trace.expectedToolCalls],
      files: ['a.ts', 'd.ts'],
    });
    const fileDiff = result.diffs.find(d => d.field === 'files');
    expect(fileDiff).toBeDefined();
    expect(fileDiff!.detail).toContain('Missing');
    expect(fileDiff!.detail).toContain('Extra');
  });

  it('returns correct traceId and traceName', () => {
    const trace = makeTrace({ id: 'my-id', name: 'my-name' });
    const result = compareWithGolden(trace, {
      output: trace.expectedOutput,
      toolCalls: [...trace.expectedToolCalls],
      files: [...trace.expectedFiles],
    });
    expect(result.traceId).toBe('my-id');
    expect(result.traceName).toBe('my-name');
  });

  it('empty strings in output treated as perfect match', () => {
    const trace = makeTrace({ expectedOutput: '' });
    const result = compareWithGolden(trace, {
      output: '',
      toolCalls: [...trace.expectedToolCalls],
      files: [...trace.expectedFiles],
    });
    expect(result.diffs.find(d => d.field === 'output')).toBeUndefined();
  });
});

// ─── captureFromRun ──────────────────────────────────────────────────

describe('captureFromRun', () => {
  it('creates a valid GoldenTrace with UUID and timestamp', () => {
    const trace = captureFromRun(
      'my-run',
      'gpt-4',
      'do something',
      'I did it',
      ['tool1', 'tool2'],
      ['file.ts'],
      { tags: ['smoke'], notes: 'baseline run' },
    );
    expect(trace.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(trace.name).toBe('my-run');
    expect(trace.model).toBe('gpt-4');
    expect(trace.input).toBe('do something');
    expect(trace.expectedOutput).toBe('I did it');
    expect(trace.expectedToolCalls).toEqual(['tool1', 'tool2']);
    expect(trace.expectedFiles).toEqual(['file.ts']);
    expect(trace.tags).toEqual(['smoke']);
    expect(trace.notes).toBe('baseline run');
    expect(() => new Date(trace.capturedAt).toISOString()).not.toThrow();
  });

  it('defaults tags to empty array when no opts', () => {
    const trace = captureFromRun('r', 'm', 'i', 'o', [], []);
    expect(trace.tags).toEqual([]);
    expect(trace.notes).toBeUndefined();
  });

  it('generates unique IDs across calls', () => {
    const a = captureFromRun('a', 'm', 'i', 'o', [], []);
    const b = captureFromRun('b', 'm', 'i', 'o', [], []);
    expect(a.id).not.toBe(b.id);
  });
});

// ─── renderDriftReport ───────────────────────────────────────────────

describe('renderDriftReport', () => {
  it('renders report with trace names and severities', () => {
    const results: DriftResult[] = [
      {
        traceId: 'id-1',
        traceName: 'trace-alpha',
        severity: 'minor',
        similarity: 0.85,
        diffs: [
          { field: 'output', expected: 'a', actual: 'b', detail: 'Output similarity: 70.0%' },
        ],
      },
      {
        traceId: 'id-2',
        traceName: 'trace-beta',
        severity: 'none',
        similarity: 1.0,
        diffs: [],
      },
    ];
    const report = renderDriftReport(results);
    expect(report).toContain('trace-alpha');
    expect(report).toContain('trace-beta');
    expect(report).toContain('minor');
    expect(report).toContain('none');
    expect(report).toContain('# Drift Report');
  });

  it('renders empty results array', () => {
    const report = renderDriftReport([]);
    expect(report).toContain('No traces compared');
  });

  it('includes diff details in the report', () => {
    const results: DriftResult[] = [
      {
        traceId: 'id-1',
        traceName: 'name',
        severity: 'major',
        similarity: 0.6,
        diffs: [
          { field: 'tool_calls', expected: '[]', actual: '["x"]', detail: 'Tool similarity: 0.0%' },
        ],
      },
    ];
    const report = renderDriftReport(results);
    expect(report).toContain('tool_calls');
    expect(report).toContain('Tool similarity');
  });
});
