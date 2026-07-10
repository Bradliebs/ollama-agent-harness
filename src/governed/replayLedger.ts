// Governed Agent Loop — idle-replay ledger.
//
// Background idle replays run while the user is away, so their outcome would
// otherwise be invisible. This module appends a durable JSONL ledger entry per
// idle-replay run to .harness/idle-replay-log.jsonl, giving a human an audit
// trail of what the loop did unattended (how many candidates it consumed,
// replayed, and re-queued for review).
//
// Mirrors the harness persistence convention: async fs, fire-and-forget append,
// failures logged not thrown (a missing ledger simply means "nothing recorded").

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../core/logger';

export interface ReplayLedgerEntry {
  /** ISO timestamp of when the idle replay finished. */
  at: string;
  /** Candidates drained from the seam during this run. */
  consumed: number;
  /** Candidates that completed a replay run. */
  replayed: number;
  /** Fresh governed answers re-entered into the human-gated review queue. */
  reQueued: number;
}

let ledgerPath: string | null = null;

export function initReplayLedger(projectDir: string): void {
  ledgerPath = path.join(projectDir, '.harness', 'idle-replay-log.jsonl');
}

/**
 * Record the outcome of one idle-replay run. Fire-and-forget: returns the
 * write promise for tests to await, but callers may ignore it. A failed write
 * is logged, never thrown, so observability never breaks the loop.
 */
export function appendReplayLedgerEntry(entry: ReplayLedgerEntry): Promise<void> {
  if (!ledgerPath) return Promise.resolve();
  const target = ledgerPath;
  const line = JSON.stringify(entry) + '\n';
  return (async () => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.appendFile(target, line, { encoding: 'utf-8', mode: 0o600 });
  })().catch((err) => logger.warn('ReplayLedger', 'Ledger append failed', { error: err instanceof Error ? err.message : String(err) }));
}

/** Read the recorded idle-replay runs, newest last. Malformed lines are skipped. */
export async function readReplayLedger(): Promise<ReplayLedgerEntry[]> {
  if (!ledgerPath) return [];
  let raw: string;
  try {
    raw = await fs.promises.readFile(ledgerPath, 'utf-8');
  } catch {
    return [];
  }
  const out: ReplayLedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.at === 'string') {
        out.push({
          at: parsed.at,
          consumed: Number(parsed.consumed) || 0,
          replayed: Number(parsed.replayed) || 0,
          reQueued: Number(parsed.reQueued) || 0,
        });
      }
    } catch (err) {
      logger.warn('ReplayLedger', 'Skipped malformed ledger line', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
