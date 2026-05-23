// Golden traces — replayable reference traces for regression detection.
//
// Captures exemplary agent runs as "golden traces" that serve as
// behavioural baselines. Future runs are compared against them to
// detect drift in output, tool usage, or file modifications.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Schema ──────────────────────────────────────────────────────────

export interface GoldenTrace {
  id: string;
  /** Human-readable name, e.g. "fix-dashboard-risk-metric" */
  name: string;
  /** ISO timestamp when this trace was captured */
  capturedAt: string;
  /** The model that produced this trace */
  model: string;
  /** The user message / task that started the run */
  input: string;
  /** The final assistant text output */
  expectedOutput: string;
  /** Tool calls made during the run, in order */
  expectedToolCalls: string[];
  /** Files modified during the run */
  expectedFiles: string[];
  /** Optional tags for filtering */
  tags: string[];
  /** Optional notes about why this is considered golden */
  notes?: string;
}

export type DriftSeverity = 'none' | 'minor' | 'major' | 'critical';

export interface DriftResult {
  traceId: string;
  traceName: string;
  severity: DriftSeverity;
  /** What changed vs the golden trace */
  diffs: DriftDiff[];
  /** Overall similarity score 0.0–1.0 */
  similarity: number;
}

export interface DriftDiff {
  field: 'output' | 'tool_calls' | 'files';
  expected: string;
  actual: string;
  detail: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const TRACES_DIR = '.harness/golden-traces';

function tracesDir(projectDir: string): string {
  return path.join(projectDir, TRACES_DIR);
}

function traceFile(projectDir: string, id: string): string {
  return path.join(tracesDir(projectDir), `${id}.json`);
}

/** Token-level Jaccard similarity: |intersection| / |union|. */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

/** Ordered comparison: matching positions / max length. */
function orderedSimilarity(expected: string[], actual: string[]): number {
  if (expected.length === 0 && actual.length === 0) return 1.0;
  const maxLen = Math.max(expected.length, actual.length);
  let matches = 0;
  for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
    if (expected[i] === actual[i]) matches++;
  }
  return matches / maxLen;
}

/** Set intersection / set union. */
function setSimilarity(expected: string[], actual: string[]): number {
  const setA = new Set(expected);
  const setB = new Set(actual);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

function classifySeverity(similarity: number): DriftSeverity {
  if (similarity >= 0.95) return 'none';
  if (similarity >= 0.8) return 'minor';
  if (similarity >= 0.5) return 'major';
  return 'critical';
}

// ─── Public API ──────────────────────────────────────────────────────

export async function saveGoldenTrace(
  projectDir: string,
  trace: GoldenTrace,
): Promise<void> {
  const dir = tracesDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(traceFile(projectDir, trace.id), JSON.stringify(trace, null, 2), 'utf-8');
}

export async function loadGoldenTrace(
  projectDir: string,
  id: string,
): Promise<GoldenTrace | undefined> {
  try {
    const raw = await fs.readFile(traceFile(projectDir, id), 'utf-8');
    return JSON.parse(raw) as GoldenTrace;
  } catch {
    return undefined;
  }
}

export async function listGoldenTraces(projectDir: string): Promise<GoldenTrace[]> {
  const dir = tracesDir(projectDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const traces: GoldenTrace[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf-8');
      traces.push(JSON.parse(raw) as GoldenTrace);
    } catch {
      // skip malformed files
    }
  }
  return traces;
}

export async function deleteGoldenTrace(
  projectDir: string,
  id: string,
): Promise<boolean> {
  try {
    await fs.unlink(traceFile(projectDir, id));
    return true;
  } catch {
    return false;
  }
}

export function compareWithGolden(
  trace: GoldenTrace,
  actual: { output: string; toolCalls: string[]; files: string[] },
): DriftResult {
  const outputSim = jaccardSimilarity(trace.expectedOutput, actual.output);
  const toolSim = orderedSimilarity(trace.expectedToolCalls, actual.toolCalls);
  const fileSim = setSimilarity(trace.expectedFiles, actual.files);

  const similarity = outputSim * 0.5 + toolSim * 0.3 + fileSim * 0.2;

  const diffs: DriftDiff[] = [];

  if (outputSim < 1.0) {
    diffs.push({
      field: 'output',
      expected: trace.expectedOutput,
      actual: actual.output,
      detail: `Output similarity: ${(outputSim * 100).toFixed(1)}%`,
    });
  }

  if (toolSim < 1.0) {
    const missing = trace.expectedToolCalls.filter((t, i) => actual.toolCalls[i] !== t);
    const extra = actual.toolCalls.filter((t, i) => trace.expectedToolCalls[i] !== t);
    diffs.push({
      field: 'tool_calls',
      expected: JSON.stringify(trace.expectedToolCalls),
      actual: JSON.stringify(actual.toolCalls),
      detail: `Tool similarity: ${(toolSim * 100).toFixed(1)}%. Missing: [${missing.join(', ')}]. Extra: [${extra.join(', ')}]`,
    });
  }

  if (fileSim < 1.0) {
    const expectedSet = new Set(trace.expectedFiles);
    const actualSet = new Set(actual.files);
    const missing = trace.expectedFiles.filter(f => !actualSet.has(f));
    const extra = actual.files.filter(f => !expectedSet.has(f));
    diffs.push({
      field: 'files',
      expected: JSON.stringify(trace.expectedFiles),
      actual: JSON.stringify(actual.files),
      detail: `File similarity: ${(fileSim * 100).toFixed(1)}%. Missing: [${missing.join(', ')}]. Extra: [${extra.join(', ')}]`,
    });
  }

  return {
    traceId: trace.id,
    traceName: trace.name,
    severity: classifySeverity(similarity),
    diffs,
    similarity,
  };
}

export function captureFromRun(
  name: string,
  model: string,
  input: string,
  output: string,
  toolCalls: string[],
  files: string[],
  opts?: { tags?: string[]; notes?: string },
): GoldenTrace {
  return {
    id: crypto.randomUUID(),
    name,
    capturedAt: new Date().toISOString(),
    model,
    input,
    expectedOutput: output,
    expectedToolCalls: toolCalls,
    expectedFiles: files,
    tags: opts?.tags ?? [],
    notes: opts?.notes,
  };
}

export function renderDriftReport(results: DriftResult[]): string {
  if (results.length === 0) {
    return '# Drift Report\n\nNo traces compared.\n';
  }

  const lines: string[] = ['# Drift Report', ''];

  for (const r of results) {
    lines.push(`## ${r.traceName} (\`${r.traceId}\`)`);
    lines.push('');
    lines.push(`- **Severity:** ${r.severity}`);
    lines.push(`- **Similarity:** ${(r.similarity * 100).toFixed(1)}%`);
    if (r.diffs.length === 0) {
      lines.push('- No differences detected.');
    } else {
      lines.push('');
      lines.push('### Diffs');
      lines.push('');
      for (const d of r.diffs) {
        lines.push(`- **${d.field}**: ${d.detail}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
