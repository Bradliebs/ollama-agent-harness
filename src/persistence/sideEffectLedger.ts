// Side-Effect Ledger — records the real-world actions a run performs so the
// run can be undone.
//
// During a run the agent mutates the world: it writes files, sends
// notifications, calls out to the network. To support "undo this run", each
// such action is recorded here together with a *compensating action* that
// describes how to reverse it — or, for things that cannot be taken back
// (a sent email, a posted message), an explicit `irreversible` marker with
// the reason. This module only RECORDS and PLANS the reversal; executing the
// compensating actions is a separate concern.
//
// Storage: .harness/side-effects.jsonl (append-only, last write wins per id),
// matching the promiseLedger / eventStore conventions.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream } from 'fs';
import { withFileLock } from './atomicFile';

// ─── Types ──────────────────────────────────────────────────────────

export type SideEffectKind =
  | 'file_create'
  | 'file_modify'
  | 'file_delete'
  | 'notification'
  | 'network_send'
  | 'other';

/**
 * The compensating action that reverses a side effect. Serializable on
 * purpose: the ledger is durable, so a revert can run in a later process.
 *   - restore_file: the path existed before; rewrite its prior content.
 *   - delete_file:  the path did not exist before; remove what was created.
 *   - irreversible: the effect cannot be undone (e.g. a sent message); the
 *                   reason is surfaced to the user instead of silently dropped.
 */
export type SideEffectReversal =
  | { kind: 'restore_file'; path: string; previousContent: string }
  | { kind: 'delete_file'; path: string }
  | { kind: 'irreversible'; reason: string };

export interface SideEffect {
  id: string;
  /** Groups every effect performed during one run, so a run reverts as a unit. */
  runId: string;
  kind: SideEffectKind;
  /** One-line human-readable summary, e.g. "wrote src/foo.ts". */
  description: string;
  reversal: SideEffectReversal;
  reversed: boolean;
  performedAt: string;
  reversedAt?: string;
}

export interface SideEffectInput {
  runId: string;
  kind: SideEffectKind;
  description: string;
  reversal: SideEffectReversal;
}

/**
 * The plan for undoing a run: which effects to compensate (in the order they
 * must run), which cannot be undone, and which were already reverted.
 */
export interface RunReversalPlan {
  runId: string;
  /**
   * Reversible, not-yet-reverted effects in REVERSE chronological order, so a
   * create-then-modify of the same path unwinds correctly (modify first, then
   * the create's delete) and later effects are undone before earlier ones.
   */
  toReverse: SideEffect[];
  /** Effects that happened and cannot be taken back — surfaced, not hidden. */
  irreversible: SideEffect[];
  /** Effects already reverted on a previous undo — left untouched. */
  alreadyReversed: SideEffect[];
}

// ─── Persistence ────────────────────────────────────────────────────

function ledgerPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'side-effects.jsonl');
}

/** Record a side effect performed during a run. */
export async function recordSideEffect(projectDir: string, input: SideEffectInput): Promise<SideEffect> {
  const effect: SideEffect = {
    id: crypto.randomUUID(),
    runId: input.runId,
    kind: input.kind,
    description: input.description,
    reversal: input.reversal,
    reversed: false,
    performedAt: new Date().toISOString(),
  };
  const fp = ledgerPath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await withFileLock(fp, () => fs.appendFile(fp, JSON.stringify(effect) + '\n', 'utf-8'));
  return effect;
}

/** List recorded side effects (optionally for one run) in chronological order. */
export async function listSideEffects(projectDir: string, runId?: string): Promise<SideEffect[]> {
  const fp = ledgerPath(projectDir);
  try { await fs.access(fp); } catch { return []; }

  // Build latest state from the append-only log (last write wins per id).
  const map = new Map<string, SideEffect>();
  const rl = readline.createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SideEffect;
      map.set(e.id, e);
    } catch { /* skip corrupt lines */ }
  }

  let results = Array.from(map.values());
  if (runId) results = results.filter((e) => e.runId === runId);
  return results.sort((a, b) => a.performedAt.localeCompare(b.performedAt));
}

/** Mark a side effect as reverted. Returns the updated record, or null if unknown. */
export async function markSideEffectReversed(
  projectDir: string,
  id: string,
  now: Date = new Date(),
): Promise<SideEffect | null> {
  const fp = ledgerPath(projectDir);
  return withFileLock(fp, async () => {
    const all = await listSideEffects(projectDir);
    const existing = all.find((e) => e.id === id);
    if (!existing) return null;
    const updated: SideEffect = { ...existing, reversed: true, reversedAt: now.toISOString() };
    await fs.appendFile(fp, JSON.stringify(updated) + '\n', 'utf-8');
    return updated;
  });
}

// ─── Reversal planning (pure) ───────────────────────────────────────

/**
 * Decide how to undo a run from its recorded effects. Pure — does no I/O — so
 * the ordering and reversible/irreversible split can be tested independently
 * of the filesystem. `effects` is expected in chronological order (as
 * `listSideEffects` returns them).
 */
export function planRunReversal(runId: string, effects: readonly SideEffect[]): RunReversalPlan {
  const forRun = effects.filter((e) => e.runId === runId);
  const alreadyReversed = forRun.filter((e) => e.reversed);
  const pending = forRun.filter((e) => !e.reversed);
  const irreversible = pending.filter((e) => e.reversal.kind === 'irreversible');
  const toReverse = pending
    .filter((e) => e.reversal.kind !== 'irreversible')
    .reverse(); // undo most-recent first so create→modify unwinds correctly
  return { runId, toReverse, irreversible, alreadyReversed };
}
