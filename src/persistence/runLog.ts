// Run log — the event-sourced record of one agent run.
//
// The global event store (eventStore.ts) is a capped, cross-cutting audit
// trail. This is the per-run causal log that makes a run reconstructable:
// every model request (as message deltas), every raw model response, every
// tool call and full tool result, and every compaction snapshot, in order,
// with a monotonic sequence number and step ids. From it you can rebuild the
// exact prompt sent on any turn, replay the run with recorded tool results,
// and roll file changes back to the end of any step (see runReverter).
//
// Storage: .harness/runs/<runId>.jsonl (one file per run, append-only).
// Retention: oldest runs are pruned beyond MAX_RUNS or MAX_TOTAL_BYTES.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from 'ollama';
import { recordSwallowed } from '../observability/silentFailureSink';
import { injectWorkingState } from '../context/workingState';

export type RunEventKind =
  | 'run_start'
  | 'messages'
  | 'compaction'
  | 'model_request'
  | 'model_response'
  | 'model_error'
  | 'tool_call'
  | 'tool_result'
  | 'route'
  | 'verdict'
  | 'supervisor'
  | 'state'
  | 'run_end';

export interface RunEvent {
  seq: number;
  ts: string;
  runId: string;
  kind: RunEventKind;
  /** Human-readable step id, e.g. "t3" (turn 3) or "t3.2" (2nd tool call of turn 3). */
  stepId?: string;
  /** Monotonic step number within the run; side effects carry the same number. */
  stepSeq?: number;
  data: Record<string, unknown>;
}

export interface RunSummary {
  runId: string;
  startedAt?: string;
  endedAt?: string;
  model?: string;
  sessionId?: string;
  reason?: string;
  turns?: number;
  events: number;
  bytes: number;
}

export const MAX_RUNS = 500;
export const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
/** Tool outputs and model text beyond this are truncated in the log (with a marker). */
export const MAX_PAYLOAD_CHARS = 256 * 1024;

const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,160}$/;

export function runsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'runs');
}

function runFile(projectDir: string, runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return path.join(runsDir(projectDir), `${runId}.jsonl`);
}

export function newRunId(prefix = 'run', now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 8);
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'run';
  return `${safePrefix}-${stamp}-${rand}`;
}

function capString(value: string): string {
  return value.length > MAX_PAYLOAD_CHARS
    ? `${value.slice(0, MAX_PAYLOAD_CHARS)}\n...[run log truncated ${value.length - MAX_PAYLOAD_CHARS} chars]`
    : value;
}

function capMessage(message: Message): Message {
  return typeof message.content === 'string' ? { ...message, content: capString(message.content) } : message;
}

export class RunLog {
  readonly runId: string;
  readonly projectDir: string;
  private seq = 0;
  private stepSeq = 0;
  private loggedMessages = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private dirReady: Promise<void> | null = null;
  private closed = false;

  constructor(projectDir: string, runId: string = newRunId()) {
    this.projectDir = projectDir;
    this.runId = runId;
    runFile(projectDir, runId);
  }

  /** Allocate the next step number. Tool calls and turns each get their own. */
  nextStep(stepId: string): { stepId: string; stepSeq: number } {
    this.stepSeq += 1;
    return { stepId, stepSeq: this.stepSeq };
  }

  get currentStepSeq(): number {
    return this.stepSeq;
  }

  append(kind: RunEventKind, data: Record<string, unknown>, step?: { stepId: string; stepSeq: number }): void {
    if (this.closed) return;
    this.seq += 1;
    const event: RunEvent = {
      seq: this.seq,
      ts: new Date().toISOString(),
      runId: this.runId,
      kind,
      ...(step ? { stepId: step.stepId, stepSeq: step.stepSeq } : {}),
      data,
    };
    const line = `${JSON.stringify(event)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.dirReady) this.dirReady = fs.mkdir(runsDir(this.projectDir), { recursive: true }).then(() => undefined);
        await this.dirReady;
        await fs.appendFile(runFile(this.projectDir, this.runId), line, 'utf-8');
      })
      .catch((err) => recordSwallowed('runLog.append', err, { runId: this.runId, kind }));
  }

  /**
   * Start a loop within this run. A run can span several loops (task mode
   * re-enters the loop per step), each with a fresh message array, so the
   * delta baseline resets here and reconstruction resets on run_start too.
   */
  startLoop(data: Record<string, unknown>): void {
    this.loggedMessages = 0;
    this.append('run_start', data);
  }

  /**
   * Record messages added since the last sync, so the log can rebuild the exact
   * array sent to the model. Call before every model request.
   */
  syncMessages(messages: readonly Message[]): void {
    if (messages.length < this.loggedMessages) {
      // The array shrank without a compaction event; re-baseline with a snapshot.
      this.recordCompaction(messages, 'rebaseline');
      return;
    }
    if (messages.length === this.loggedMessages) return;
    this.append('messages', { from: this.loggedMessages, messages: messages.slice(this.loggedMessages).map(capMessage) });
    this.loggedMessages = messages.length;
  }

  /** Record a full replacement of the message array (compaction or rebaseline). */
  recordCompaction(messages: readonly Message[], strategy: string, extra: Record<string, unknown> = {}): void {
    this.append('compaction', { strategy, ...extra, messages: messages.map(capMessage) });
    this.loggedMessages = messages.length;
  }

  recordToolResult(step: { stepId: string; stepSeq: number } | undefined, data: { name: string; success: boolean; output: unknown; error?: unknown; provenance?: string; [key: string]: unknown }): void {
    const output = typeof data.output === 'string' ? capString(data.output) : data.output;
    this.append('tool_result', { ...data, output }, step);
  }

  /** Wait for queued writes (tests, run end). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

export async function readRunEvents(projectDir: string, runId: string): Promise<RunEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(runFile(projectDir, runId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const events: RunEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // A torn trailing line from a crash: keep everything before it.
    }
  }
  return events.sort((a, b) => a.seq - b.seq);
}

/**
 * Rebuild the message array as it stood after event `uptoSeq` (inclusive), or
 * at the end of the log. Applies message deltas and compaction snapshots in
 * order, so the result equals what the loop held at that point.
 */
export function reconstructMessages(events: readonly RunEvent[], uptoSeq = Number.POSITIVE_INFINITY): Message[] {
  let messages: Message[] = [];
  for (const event of events) {
    if (event.seq > uptoSeq) break;
    if (event.kind === 'run_start') {
      messages = [];
    } else if (event.kind === 'compaction') {
      messages = [...((event.data.messages as Message[] | undefined) ?? [])];
    } else if (event.kind === 'messages') {
      const from = Number(event.data.from ?? messages.length);
      messages = [...messages.slice(0, from), ...((event.data.messages as Message[] | undefined) ?? [])];
    }
  }
  return messages;
}

/** The message array sent on each recorded model request, in order. */
export function reconstructModelRequests(events: readonly RunEvent[]): Array<{ seq: number; stepId?: string; messages: Message[] }> {
  return events
    .filter((event) => event.kind === 'model_request')
    .map((event) => {
      const count = Number(event.data.messageCount);
      const base = reconstructMessages(events, event.seq);
      const sliced = Number.isFinite(count) ? base.slice(0, count) : base;
      // Working state is injected into the system prompt at call time, not
      // stored in the transcript; the request event carries the rendered text.
      const messages = typeof event.data.workingState === 'string' && event.data.workingState
        ? injectWorkingState(sliced, event.data.workingState)
        : sliced;
      return { seq: event.seq, stepId: event.stepId, messages };
    });
}

export function summarizeRun(runId: string, events: readonly RunEvent[], bytes = 0): RunSummary {
  const start = events.find((event) => event.kind === 'run_start');
  const end = [...events].reverse().find((event) => event.kind === 'run_end');
  return {
    runId,
    startedAt: start?.ts,
    endedAt: end?.ts,
    model: typeof start?.data.model === 'string' ? start.data.model : undefined,
    sessionId: typeof start?.data.sessionId === 'string' ? start.data.sessionId : undefined,
    reason: typeof end?.data.reason === 'string' ? end.data.reason : undefined,
    turns: typeof end?.data.turns === 'number' ? end.data.turns : undefined,
    events: events.length,
    bytes,
  };
}

async function listRunFiles(projectDir: string): Promise<Array<{ runId: string; file: string; mtimeMs: number; size: number }>> {
  let names: string[];
  try {
    names = await fs.readdir(runsDir(projectDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = await Promise.all(names
    .filter((name) => name.endsWith('.jsonl'))
    .map(async (name) => {
      const file = path.join(runsDir(projectDir), name);
      try {
        const stat = await fs.stat(file);
        return { runId: name.slice(0, -'.jsonl'.length), file, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    }));
  return files.filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function listRuns(projectDir: string, limit = 50): Promise<RunSummary[]> {
  const files = (await listRunFiles(projectDir)).slice(0, Math.max(0, limit));
  return Promise.all(files.map(async (entry) => summarizeRun(entry.runId, await readRunEvents(projectDir, entry.runId), entry.size)));
}

/** Delete the oldest runs beyond the count and size limits. Returns removed run ids. */
export async function pruneRuns(projectDir: string, limits: { maxRuns?: number; maxBytes?: number } = {}): Promise<string[]> {
  const maxRuns = limits.maxRuns ?? MAX_RUNS;
  const maxBytes = limits.maxBytes ?? MAX_TOTAL_BYTES;
  const files = await listRunFiles(projectDir);
  const removed: string[] = [];
  let total = 0;
  for (let index = 0; index < files.length; index += 1) {
    const entry = files[index];
    total += entry.size;
    if (index >= maxRuns || total > maxBytes) {
      try {
        await fs.unlink(entry.file);
        removed.push(entry.runId);
      } catch (err) {
        recordSwallowed('runLog.prune', err, { runId: entry.runId });
      }
    }
  }
  return removed;
}
