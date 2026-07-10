// Durable, append-only job ledger for crash-recoverable automation runs.
//
// Each per-job invocation appends a `start` event before executing and an
// `end` event after. A crash leaves a `start` with no matching `end`. On
// next boot `recoverOrphanedJobs()` walks the ledger, identifies un-ended
// starts whose last activity is older than `staleAfterMs`, and appends an
// `orphaned` event so the same entry is not flagged twice and the web UI
// can show what was lost.
//
// Storage: `.harness/automations/inflight.jsonl` — one JSON object per line.
// JSONL append is naturally crash-safe (each line is a complete record), so
// no atomic-rename or lockfile is required for the append path.
//
// Out of scope (per locked Phase 2 plan):
//   - Heartbeat plumbing inside the scheduler. The API exists for future
//     long-running consumers; the current scheduler runs short scripts
//     (30s timeout) where heartbeats add noise without value.
//   - Auto-resume from checkpoint. `checkpoint` is recorded if provided
//     but the orphan event is the deliberate stopping point — a human
//     decides what to do next.

import { promises as fs } from 'fs';
import * as path from 'path';

export type LedgerJobStatus = 'running' | 'completed' | 'failed' | 'orphaned';
export type LedgerJobKind = 'cron' | 'opportunistic' | 'manual';

export interface LedgerStartEvent {
  type: 'start';
  jobId: string;
  name: string;
  kind: LedgerJobKind;
  startedAt: string;
  /** Caller-supplied; used to correlate retries / re-runs across boots. */
  runId: string;
}

export interface LedgerHeartbeatEvent {
  type: 'heartbeat';
  jobId: string;
  runId: string;
  at: string;
  checkpoint?: unknown;
}

export interface LedgerEndEvent {
  type: 'end';
  jobId: string;
  runId: string;
  endedAt: string;
  success: boolean;
  error?: string;
}

export interface LedgerOrphanedEvent {
  type: 'orphaned';
  jobId: string;
  runId: string;
  detectedAt: string;
  /** ms since the start (or last heartbeat) when the orphan was flagged. */
  staleForMs: number;
}

export type LedgerEvent = LedgerStartEvent | LedgerHeartbeatEvent | LedgerEndEvent | LedgerOrphanedEvent;

export interface RunningEntry {
  jobId: string;
  name: string;
  kind: LedgerJobKind;
  runId: string;
  startedAt: string;
  lastHeartbeatAt?: string;
  checkpoint?: unknown;
}

export interface OrphanedEntry {
  jobId: string;
  name: string;
  kind: LedgerJobKind;
  runId: string;
  startedAt: string;
  lastHeartbeatAt?: string;
  detectedAt: string;
  staleForMs: number;
}

export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export function jobLedgerPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'automations', 'inflight.jsonl');
}

async function appendEvent(projectDir: string, event: LedgerEvent): Promise<void> {
  const filePath = jobLedgerPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

/** Read the entire ledger. Corrupt lines are skipped rather than crashing. */
export async function readLedger(projectDir: string): Promise<LedgerEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(jobLedgerPath(projectDir), 'utf-8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return [];
    throw err;
  }
  const out: LedgerEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LedgerEvent);
    } catch {
      // Skip — a torn write would leave at most one bad line at EOF.
    }
  }
  return out;
}

export interface StartJobInput {
  jobId: string;
  name: string;
  kind: LedgerJobKind;
  /** Optional — defaults to a generated id correlating start/heartbeat/end. */
  runId?: string;
}

export interface StartedJob {
  runId: string;
  startedAt: string;
}

export async function startJob(projectDir: string, input: StartJobInput, now: Date = new Date()): Promise<StartedJob> {
  const runId = input.runId ?? `${input.jobId}:${now.getTime().toString(36)}`;
  const startedAt = now.toISOString();
  await appendEvent(projectDir, {
    type: 'start',
    jobId: input.jobId,
    name: input.name,
    kind: input.kind,
    startedAt,
    runId,
  });
  return { runId, startedAt };
}

export async function heartbeatJob(
  projectDir: string,
  jobId: string,
  runId: string,
  opts: { checkpoint?: unknown } = {},
  now: Date = new Date(),
): Promise<void> {
  await appendEvent(projectDir, {
    type: 'heartbeat',
    jobId,
    runId,
    at: now.toISOString(),
    ...(opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {}),
  });
}

export interface CompleteJobInput {
  jobId: string;
  runId: string;
  success: boolean;
  error?: string;
}

export async function completeJob(projectDir: string, input: CompleteJobInput, now: Date = new Date()): Promise<void> {
  await appendEvent(projectDir, {
    type: 'end',
    jobId: input.jobId,
    runId: input.runId,
    endedAt: now.toISOString(),
    success: input.success,
    ...(input.error ? { error: input.error } : {}),
  });
}

/**
 * Replay the ledger and return runs that are still considered "running" — a
 * `start` with no matching `end` and no later `orphaned` event for the same
 * runId. The `lastHeartbeatAt` reflects the latest heartbeat seen, if any.
 */
export function collectRunningEntries(events: ReadonlyArray<LedgerEvent>): RunningEntry[] {
  const byRunId = new Map<string, RunningEntry>();
  const ended = new Set<string>();
  for (const ev of events) {
    if (ev.type === 'start') {
      byRunId.set(ev.runId, {
        jobId: ev.jobId,
        name: ev.name,
        kind: ev.kind,
        runId: ev.runId,
        startedAt: ev.startedAt,
      });
    } else if (ev.type === 'heartbeat') {
      const existing = byRunId.get(ev.runId);
      if (existing) {
        existing.lastHeartbeatAt = ev.at;
        if (ev.checkpoint !== undefined) existing.checkpoint = ev.checkpoint;
      }
    } else if (ev.type === 'end' || ev.type === 'orphaned') {
      ended.add(ev.runId);
    }
  }
  return Array.from(byRunId.values()).filter((e) => !ended.has(e.runId));
}

export interface RecoverOrphanedJobsOptions {
  staleAfterMs?: number;
  now?: Date;
  /**
   * Called once per orphan discovered. Fire-and-forget at the call site —
   * a failing handler must not block recovery (we log loudly and continue).
   */
  onOrphan?: (entry: OrphanedEntry) => void | Promise<void>;
  /** Sink for handler errors. Defaults to `console.error`. */
  logError?: (msg: string) => void;
}

/**
 * Scan the ledger, mark stale running entries as orphaned, and return them.
 * Idempotent: a second call returns nothing because the first appended an
 * `orphaned` event for each entry. Safe to invoke at every boot.
 */
export async function recoverOrphanedJobs(
  projectDir: string,
  options: RecoverOrphanedJobsOptions = {},
): Promise<OrphanedEntry[]> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const events = await readLedger(projectDir);
  const running = collectRunningEntries(events);
  const orphans: OrphanedEntry[] = [];
  for (const entry of running) {
    const lastActivityMs = Date.parse(entry.lastHeartbeatAt ?? entry.startedAt);
    if (!Number.isFinite(lastActivityMs)) continue;
    const staleForMs = nowMs - lastActivityMs;
    if (staleForMs < staleAfterMs) continue;
    const orphan: OrphanedEntry = {
      jobId: entry.jobId,
      name: entry.name,
      kind: entry.kind,
      runId: entry.runId,
      startedAt: entry.startedAt,
      lastHeartbeatAt: entry.lastHeartbeatAt,
      detectedAt: now.toISOString(),
      staleForMs,
    };
    await appendEvent(projectDir, {
      type: 'orphaned',
      jobId: orphan.jobId,
      runId: orphan.runId,
      detectedAt: orphan.detectedAt,
      staleForMs: orphan.staleForMs,
    });
    if (options.onOrphan) {
      try {
        await options.onOrphan(orphan);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        (options.logError ?? console.error)(`[jobLedger] onOrphan handler failed for ${orphan.jobId}: ${msg}`);
      }
    }
    orphans.push(orphan);
  }
  return orphans;
}

/**
 * List orphan events recorded since `since` (defaults to all). Used by the
 * web UI to show what was lost. Returns the most recent first.
 */
export async function listOrphanedRuns(
  projectDir: string,
  options: { since?: Date; limit?: number } = {},
): Promise<OrphanedEntry[]> {
  const events = await readLedger(projectDir);
  // Index name/kind/startedAt from the start events so we can hydrate.
  const starts = new Map<string, LedgerStartEvent>();
  const heartbeats = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === 'start') starts.set(ev.runId, ev);
    else if (ev.type === 'heartbeat') heartbeats.set(ev.runId, ev.at);
  }
  const sinceMs = options.since?.getTime() ?? 0;
  const out: OrphanedEntry[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== 'orphaned') continue;
    if (Date.parse(ev.detectedAt) < sinceMs) continue;
    const start = starts.get(ev.runId);
    if (!start) continue;
    out.push({
      jobId: ev.jobId,
      name: start.name,
      kind: start.kind,
      runId: ev.runId,
      startedAt: start.startedAt,
      lastHeartbeatAt: heartbeats.get(ev.runId),
      detectedAt: ev.detectedAt,
      staleForMs: ev.staleForMs,
    });
    if (options.limit && out.length >= options.limit) break;
  }
  return out;
}
