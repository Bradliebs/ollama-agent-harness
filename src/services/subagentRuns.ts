// Persistent sub-agent run log.
//
// Every sub-agent invocation is captured here after it finishes so the
// user can see "what agents have run, with what input, what came out, and
// where any files landed". Lightweight by design: a single append-only
// JSONL under .harness/subagent-runs/runs.jsonl with bounded size.
//
// We deliberately keep this separate from the chat event store so the
// Agents tab UI can read it cheaply without scanning the entire session
// history.

import * as fs from 'fs/promises';
import * as path from 'path';
import { withFileLock } from '../persistence/atomicFile';
import { recordSwallowed } from '../observability/silentFailureSink';

export interface SubagentRunRecord {
  /** Unique runId — same as the one used in the active registry. */
  runId: string;
  /** Agent name / id. */
  name: string;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** ISO timestamp the run ended (success, failure, or cancellation). */
  endedAt: string;
  durationMs: number;
  /** Status: completed when the run produced output, cancelled when aborted, failed when an error escaped. */
  status: 'completed' | 'cancelled' | 'failed';
  /** Truncated prompt — first 500 chars. */
  prompt: string;
  /** Truncated output — first 2000 chars. */
  output: string;
  /** Ordered tool labels the agent called (max 50). */
  toolHistory: string[];
  /** Sub-agent's effective model when known. */
  model?: string;
  /** Resolved agent output directory at the time of the run. */
  outputDir?: string;
  /** Optional error message when status === 'failed'. */
  error?: string;
}

const MAX_RECORDS = 200;

function runsPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'subagent-runs', 'runs.jsonl');
}

/** Append a run record, trimming the log to MAX_RECORDS entries. */
export async function appendSubagentRun(projectDir: string, record: SubagentRunRecord): Promise<void> {
  const fp = runsPath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await withFileLock(fp, async () => {
    let existing = '';
    try { existing = await fs.readFile(fp, 'utf-8'); } catch { /* first write */ }
    const lines = existing.split(/\r?\n/).filter((line) => line.trim().length > 0);
    lines.push(JSON.stringify(record));
    const trimmed = lines.length > MAX_RECORDS ? lines.slice(lines.length - MAX_RECORDS) : lines;
    await fs.writeFile(fp, trimmed.join('\n') + '\n', 'utf-8');
  }).catch((err) => recordSwallowed('subagentRuns.append', err));
}

/** Return the most recent runs, newest first. */
export async function listSubagentRuns(projectDir: string, limit = 50): Promise<SubagentRunRecord[]> {
  const fp = runsPath(projectDir);
  let raw = '';
  try { raw = await fs.readFile(fp, 'utf-8'); } catch { return []; }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const records: SubagentRunRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as SubagentRunRecord;
      if (parsed && typeof parsed.runId === 'string') records.push(parsed);
    } catch { /* skip corrupt line */ }
  }
  return records;
}

/** Look up a single run by id. */
export async function getSubagentRun(projectDir: string, runId: string): Promise<SubagentRunRecord | null> {
  const all = await listSubagentRuns(projectDir, MAX_RECORDS);
  return all.find((record) => record.runId === runId) ?? null;
}
