// Event Store — append-only event log with temporal queries, snapshots, and undo.
//
// Every significant action in the harness produces an event. Events are
// immutable once written. Snapshots capture point-in-time state for fast
// restore. Undo replays events up to (but not including) a target event.
//
// Storage: .harness/events/events.jsonl (append-only)
//          .harness/events/snapshots/ (per-service JSON snapshots)

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream, existsSync } from 'fs';

// ─── Types ──────────────────────────────────────────────────────────

export type EventCategory =
  | 'service'
  | 'promise'
  | 'task'
  | 'tool'
  | 'model'
  | 'route'
  | 'approval'
  | 'file'
  | 'schedule'
  | 'notification'
  | 'permission'
  | 'system';

export interface HarnessEvent {
  event_id: string;
  category: EventCategory;
  type: string;
  /** ISO timestamp. */
  timestamp: string;
  /**
   * Process-local monotonic sequence number. Assigned by appendEvent so
   * events emitted in the same millisecond keep a deterministic order even
   * when timestamps tie. Optional for backward compatibility with legacy
   * JSONL lines written before this field existed.
   */
  seq?: number;
  /** Optional correlation key (service_id, session_id, etc). */
  subject_id?: string;
  /** Structured payload. */
  data: Record<string, unknown>;
  /** Actor: user, agent, scheduler, system. */
  actor: string;
  /** Optional parent event for causal chains. */
  parent_event_id?: string;
}

export interface EventSnapshot {
  snapshot_id: string;
  subject_id: string;
  timestamp: string;
  state: Record<string, unknown>;
  last_event_id: string;
}

export interface EventQuery {
  category?: EventCategory;
  type?: string;
  subject_id?: string;
  after?: string;  // ISO timestamp
  before?: string; // ISO timestamp
  limit?: number;
  actor?: string;
}

export interface EventStoreSummary {
  total_events: number;
  categories: Record<string, number>;
  first_event_at?: string;
  last_event_at?: string;
  snapshot_count: number;
}

// ─── Paths ──────────────────────────────────────────────────────────

function eventsFilePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'events', 'events.jsonl');
}

function snapshotsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'events', 'snapshots');
}

// ─── Write ──────────────────────────────────────────────────────────

const MAX_EVENT_LINES = 10_000;
let knownEventLineCount = -1;
let appendSeq = 0;
// Serialize background pruning + appends so concurrent emissions can't race
// with a prune (which rewrites the file). Reads still see the file at a
// consistent moment because fs.appendFile and fs.writeFile are atomic at the
// syscall level on every supported OS, but the in-memory invariants
// (knownEventLineCount, appendSeq) only stay correct if we serialize.
let writeChain: Promise<unknown> = Promise.resolve();

/** SSE subscribers for live event streaming. */
const eventStreamListeners = new Set<(event: HarnessEvent) => void>();

export function subscribeEventStream(listener: (event: HarnessEvent) => void): () => void {
  eventStreamListeners.add(listener);
  return () => { eventStreamListeners.delete(listener); };
}

export async function appendEvent(projectDir: string, event: Omit<HarnessEvent, 'event_id' | 'timestamp' | 'seq'>): Promise<HarnessEvent> {
  const next = writeChain.then(async () => {
    const full: HarnessEvent = {
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      seq: ++appendSeq,
      ...event,
    };
    const fp = eventsFilePath(projectDir);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.appendFile(fp, JSON.stringify(full) + '\n', 'utf-8');
    // Notify live stream listeners.
    for (const listener of eventStreamListeners) {
      try { listener(full); } catch { /* best-effort */ }
    }
    // Auto-prune when line count is estimated to exceed the cap. Awaited so
    // the next chained append/query observes the post-prune state.
    knownEventLineCount = knownEventLineCount < 0 ? MAX_EVENT_LINES : knownEventLineCount + 1;
    if (knownEventLineCount > MAX_EVENT_LINES) {
      try { await pruneEventStore(projectDir, MAX_EVENT_LINES); } catch { /* best-effort */ }
    }
    return full;
  });
  // Keep the chain alive even if this append rejects.
  writeChain = next.catch(() => {});
  return next;
}

/** Convenience: emit a typed event. */
export function emitEvent(
  projectDir: string,
  category: EventCategory,
  type: string,
  data: Record<string, unknown>,
  actor = 'system',
  subjectId?: string,
  parentEventId?: string,
): Promise<HarnessEvent> {
  return appendEvent(projectDir, { category, type, data, actor, subject_id: subjectId, parent_event_id: parentEventId });
}

// ─── Read / Query ───────────────────────────────────────────────────

export async function queryEvents(projectDir: string, query: EventQuery = {}): Promise<HarnessEvent[]> {
  const fp = eventsFilePath(projectDir);
  try { await fs.access(fp); } catch { return []; }

  const results: HarnessEvent[] = [];
  const rl = readline.createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });

  // Track file-append order so equal-timestamp events (rapid emissions in the
  // same millisecond) keep a deterministic chronological order. Without this
  // tiebreaker the DESC sort is stable but downstream callers that reverse the
  // result get reordered events whenever timestamps tie. See eventStore.test
  // 'gets undo events'.
  const appendOrder = new Map<string, number>();
  let nextOrder = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as HarnessEvent;
      if (query.category && ev.category !== query.category) continue;
      if (query.type && ev.type !== query.type) continue;
      if (query.subject_id && ev.subject_id !== query.subject_id) continue;
      if (query.actor && ev.actor !== query.actor) continue;
      if (query.after && ev.timestamp <= query.after) continue;
      if (query.before && ev.timestamp >= query.before) continue;
      appendOrder.set(ev.event_id, nextOrder++);
      results.push(ev);
    } catch { /* skip corrupt lines */ }
  }

  // Most recent first; tie-break by seq when present, else by file-append order so
  // chronological reversal stays deterministic.
  results.sort((a, b) => {
    const cmp = b.timestamp.localeCompare(a.timestamp);
    if (cmp !== 0) return cmp;
    if (typeof a.seq === 'number' && typeof b.seq === 'number') return b.seq - a.seq;
    return (appendOrder.get(b.event_id) ?? 0) - (appendOrder.get(a.event_id) ?? 0);
  });
  if (query.limit && results.length > query.limit) results.length = query.limit;
  return results;
}

export async function getEvent(projectDir: string, eventId: string): Promise<HarnessEvent | null> {
  const fp = eventsFilePath(projectDir);
  try { await fs.access(fp); } catch { return null; }
  const rl = readline.createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as HarnessEvent;
      if (ev.event_id === eventId) { rl.close(); return ev; }
    } catch { /* skip */ }
  }
  return null;
}

// ─── Snapshots ──────────────────────────────────────────────────────

export async function createSnapshot(
  projectDir: string,
  subjectId: string,
  state: Record<string, unknown>,
  lastEventId: string,
): Promise<EventSnapshot> {
  const snapshot: EventSnapshot = {
    snapshot_id: crypto.randomUUID(),
    subject_id: subjectId,
    timestamp: new Date().toISOString(),
    state,
    last_event_id: lastEventId,
  };
  const dir = snapshotsDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${subjectId}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');
  return snapshot;
}

export async function getSnapshot(projectDir: string, subjectId: string): Promise<EventSnapshot | null> {
  const fp = path.join(snapshotsDir(projectDir), `${subjectId}.json`);
  try {
    const raw = await fs.readFile(fp, 'utf-8');
    return JSON.parse(raw) as EventSnapshot;
  } catch {
    return null;
  }
}

export async function listSnapshots(projectDir: string): Promise<string[]> {
  const dir = snapshotsDir(projectDir);
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

// ─── Undo ───────────────────────────────────────────────────────────

/**
 * Replay events for a subject, stopping before a target event.
 * Returns all events that would remain after "undoing" the target event
 * and everything after it.
 */
export async function getUndoEvents(
  projectDir: string,
  subjectId: string,
  undoBeforeEventId: string,
): Promise<HarnessEvent[]> {
  const all = await queryEvents(projectDir, { subject_id: subjectId });
  // Events are sorted most-recent-first; reverse for chronological
  all.reverse();
  const cutoff = all.findIndex((ev) => ev.event_id === undoBeforeEventId);
  if (cutoff < 0) return all; // target not found, return all
  return all.slice(0, cutoff);
}

// ─── Summary / Stats ────────────────────────────────────────────────

export async function summarizeEventStore(projectDir: string): Promise<EventStoreSummary> {
  const fp = eventsFilePath(projectDir);
  const categories: Record<string, number> = {};
  let total = 0;
  let firstAt: string | undefined;
  let lastAt: string | undefined;

  try { await fs.access(fp); } catch {
    const snapshots = await listSnapshots(projectDir);
    return { total_events: 0, categories, snapshot_count: snapshots.length };
  }

  const rl = readline.createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as HarnessEvent;
      total++;
      categories[ev.category] = (categories[ev.category] ?? 0) + 1;
      if (!firstAt || ev.timestamp < firstAt) firstAt = ev.timestamp;
      if (!lastAt || ev.timestamp > lastAt) lastAt = ev.timestamp;
    } catch { /* skip */ }
  }

  const snapshots = await listSnapshots(projectDir);
  return { total_events: total, categories, first_event_at: firstAt, last_event_at: lastAt, snapshot_count: snapshots.length };
}

// ─── Postmortem ─────────────────────────────────────────────────────

/** Generate a text summary of events around a failure. */
export async function generatePostmortem(
  projectDir: string,
  subjectId: string,
  windowMinutes = 30,
): Promise<string> {
  const events = await queryEvents(projectDir, { subject_id: subjectId });
  if (events.length === 0) return `No events found for ${subjectId}.`;

  // Find failure events
  const failures = events.filter((ev) => ev.type.includes('fail') || ev.type.includes('error') || ev.data?.success === false);
  if (failures.length === 0) return `No failure events found for ${subjectId}.`;

  const latestFailure = failures[0];
  const windowStart = new Date(new Date(latestFailure.timestamp).getTime() - windowMinutes * 60_000).toISOString();
  const windowEvents = events.filter((ev) => ev.timestamp >= windowStart);

  const lines = [
    `# Postmortem: ${subjectId}`,
    ``,
    `**Latest failure:** ${latestFailure.type} at ${latestFailure.timestamp}`,
    `**Window:** ${windowMinutes} minutes before failure`,
    `**Events in window:** ${windowEvents.length}`,
    ``,
    `## Timeline`,
    ``,
  ];

  for (const ev of windowEvents.reverse()) {
    const marker = ev.event_id === latestFailure.event_id ? ' ← FAILURE' : '';
    lines.push(`- **${ev.timestamp}** [${ev.category}/${ev.type}] ${JSON.stringify(ev.data).slice(0, 120)}${marker}`);
  }

  return lines.join('\n');
}

// ─── Pruning ────────────────────────────────────────────────────────

/** Keep only the most recent `maxEntries` events. */
export async function pruneEventStore(projectDir: string, maxEntries = MAX_EVENT_LINES): Promise<number> {
  const fp = eventsFilePath(projectDir);
  try { await fs.access(fp); } catch { return 0; }

  const entries: string[] = [];
  const rl = readline.createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) entries.push(line);
  }

  if (entries.length <= maxEntries) {
    knownEventLineCount = entries.length;
    return 0;
  }

  const kept = entries.slice(-maxEntries);
  await fs.writeFile(fp, kept.join('\n') + '\n', 'utf-8');
  const pruned = entries.length - kept.length;
  knownEventLineCount = kept.length;
  return pruned;
}

/** Remove events older than `retentionDays`. */
export async function pruneEventsByAge(projectDir: string, retentionDays = 30): Promise<number> {
  const fp = eventsFilePath(projectDir);
  try { await fs.access(fp); } catch { return 0; }

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const kept: string[] = [];
  let pruned = 0;
  const rl = readline.createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as HarnessEvent;
      if (ev.timestamp >= cutoff) {
        kept.push(line);
      } else {
        pruned++;
      }
    } catch {
      kept.push(line); // keep unparseable lines
    }
  }
  if (pruned > 0) {
    await fs.writeFile(fp, kept.join('\n') + '\n', 'utf-8');
    knownEventLineCount = kept.length;
  }
  return pruned;
}
