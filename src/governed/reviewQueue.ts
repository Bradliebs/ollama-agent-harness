// Governed Agent Loop — review queue.
//
// One durable, human-gated queue for two governance lifecycles that share the
// same shape (a pending item resolved with an outcome):
//
//   - 'brain-update'  : a fact the governed pass proposed saving. Resolving it
//                       'approved' appends to an audit log (brain-approved.jsonl)
//                       AND teaches the harness's durable brain by appending the
//                       fact to .harness/memory/patterns.md; 'rejected' drops it.
//                       Writes happen ONLY on an explicit human approval.
//   - 'needs-review'  : an answer the self-critique flagged for review. Resolving
//                       it 'drained' appends a replay candidate to a durable
//                       .harness/needs-review-replay.jsonl seam that an
//                       auto-research / replay consumer reads.
//
// Mirrors the harness persistence convention: synchronous in-memory load,
// fire-and-forget atomic writes (0o600), failures logged not thrown.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { logger } from '../core/logger';
import type { GovernedAnswer } from './governedAnswer';

export type ReviewItemKind = 'brain-update' | 'needs-review';
export type ReviewItemStatus = 'pending' | 'approved' | 'rejected' | 'drained';

export interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  content: string;
  reason: string;
  status: ReviewItemStatus;
  createdAt: string;
  resolvedAt?: string;
  /** When this item is the result of replaying a drained answer, the id of the original. */
  replayOf?: string;
  /** The original drained answer this replay re-investigated, for a before/after view. */
  priorContent?: string;
}

export interface EnqueueReviewInput {
  kind: ReviewItemKind;
  content: string;
  reason: string;
  replayOf?: string;
  priorContent?: string;
}

const items: ReviewItem[] = [];
let storePath: string | null = null;
let approvedLogPath: string | null = null;
let brainMemoryPath: string | null = null;
let replayLogPath: string | null = null;

const pendingWrites: Set<Promise<unknown>> = new Set();

function trackWrite(p: Promise<unknown>): void {
  pendingWrites.add(p);
  void p.finally(() => pendingWrites.delete(p));
}

/** Test hook: await all in-flight writes before cleaning up temp dirs. */
export async function flushReviewQueueWritesForTest(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

export function initReviewQueue(projectDir: string): void {
  storePath = path.join(projectDir, '.harness', 'review-queue.json');
  approvedLogPath = path.join(projectDir, '.harness', 'brain-approved.jsonl');
  // The harness's durable learned-patterns brain (same file the session-learning
  // promotion path writes to). An approved brain-update teaches it directly.
  brainMemoryPath = path.join(projectDir, '.harness', 'memory', 'patterns.md');
  // Durable seam for the replay / auto-research consumer of drained answers.
  replayLogPath = path.join(projectDir, '.harness', 'needs-review-replay.jsonl');
  // Clear unconditionally so a missing/unreadable file resets the in-memory
  // queue instead of leaking a prior project's items.
  items.length = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!isValidKind(entry?.kind) || typeof entry.id !== 'string') continue;
        items.push({
          id: entry.id,
          kind: entry.kind,
          content: typeof entry.content === 'string' ? entry.content : '',
          reason: typeof entry.reason === 'string' ? entry.reason : '',
          status: isValidStatus(entry.status) ? entry.status : 'pending',
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
          resolvedAt: typeof entry.resolvedAt === 'string' ? entry.resolvedAt : undefined,
          replayOf: typeof entry.replayOf === 'string' ? entry.replayOf : undefined,
          priorContent: typeof entry.priorContent === 'string' ? entry.priorContent : undefined,
        });
      }
    }
  } catch {
    // No store yet (or unreadable) — start empty; created on first write.
  }
}

export function enqueueReviewItem(input: EnqueueReviewInput): ReviewItem {
  const item: ReviewItem = {
    id: crypto.randomUUID(),
    kind: input.kind,
    content: input.content,
    reason: input.reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...(input.replayOf !== undefined ? { replayOf: input.replayOf } : {}),
    ...(input.priorContent !== undefined ? { priorContent: input.priorContent } : {}),
  };
  items.push(item);
  persist();
  return item;
}

export function listReviewItems(filter: { status?: ReviewItemStatus; kind?: ReviewItemKind } = {}): ReviewItem[] {
  return items.filter(
    (i) => (filter.status === undefined || i.status === filter.status)
      && (filter.kind === undefined || i.kind === filter.kind),
  );
}

export interface GovernanceMetrics {
  /** Items still awaiting a human decision. */
  staged: number;
  /** Items a human approved (brain-updates became durable facts). */
  approved: number;
  /** Items a human rejected. */
  rejected: number;
  /** Needs-review answers a human drained onto the replay seam. */
  drained: number;
  /** Items that re-entered the queue as the result of a replay. */
  reQueued: number;
}

/** Lifetime counts of the governed-loop review queue, for a small surface readout. */
export function getGovernanceMetrics(): GovernanceMetrics {
  let staged = 0, approved = 0, rejected = 0, drained = 0, reQueued = 0;
  for (const i of items) {
    if (i.status === 'pending') staged++;
    else if (i.status === 'approved') approved++;
    else if (i.status === 'rejected') rejected++;
    else if (i.status === 'drained') drained++;
    if (i.replayOf !== undefined) reQueued++;
  }
  return { staged, approved, rejected, drained, reQueued };
}

/**
 * Resolve a pending item. 'approved' on a brain-update appends the fact to the
 * audit log (the only place an approved fact is written). Returns null for an
 * unknown id or an item that was already resolved.
 */
export function resolveReviewItem(
  id: string,
  outcome: Exclude<ReviewItemStatus, 'pending'>,
): ReviewItem | null {
  const item = items.find((i) => i.id === id);
  if (!item || item.status !== 'pending') return null;
  item.status = outcome;
  item.resolvedAt = new Date().toISOString();
  if (outcome === 'approved' && item.kind === 'brain-update') {
    appendApproved(item);
    appendToBrain(item);
  }
  if (outcome === 'drained' && item.kind === 'needs-review') {
    appendReplayCandidate(item);
  }
  persist();
  return item;
}

/**
 * Map a governed answer into queue entries without writing anything durable
 * beyond enqueueing: a flagged answer becomes a 'needs-review' item, and each
 * staged brain-update proposal becomes a 'brain-update' item awaiting approval.
 */
export function enqueueFromGoverned(
  governed: GovernedAnswer,
  replayContext?: { replayOf: string; priorContent: string },
): ReviewItem[] {
  const enqueued: ReviewItem[] = [];
  // When this answer is the result of replaying a drained one, note whether the
  // re-investigation actually changed it and carry the prior text for a
  // before/after view in the review surface.
  const replayFields = replayContext
    ? { replayOf: replayContext.replayOf, priorContent: replayContext.priorContent }
    : {};
  const replayNote = replayContext
    ? `; replay of ${replayContext.replayOf} (${replayContext.priorContent.trim() === governed.answer.trim() ? 'unchanged' : 'changed'})`
    : '';
  if (governed.critique.overall === 'review') {
    enqueued.push(enqueueReviewItem({
      kind: 'needs-review',
      content: governed.answer,
      reason: `${governed.confidence.mode}: ${governed.confidence.reason}${replayNote}`,
      ...replayFields,
    }));
  }
  for (const proposal of governed.proposedBrainUpdates) {
    enqueued.push(enqueueReviewItem({
      kind: 'brain-update',
      content: proposal.content,
      reason: `${proposal.reason}${replayNote}`,
      ...replayFields,
    }));
  }
  return enqueued;
}

function appendApproved(item: ReviewItem): void {
  if (!approvedLogPath) return;
  const line = JSON.stringify({ content: item.content, reason: item.reason, approvedAt: item.resolvedAt }) + '\n';
  trackWrite(
    fs.promises.appendFile(approvedLogPath, line, { encoding: 'utf-8', mode: 0o600 })
      .catch((err) => logger.warn('ReviewQueue', 'Approved-log append failed', { error: err instanceof Error ? err.message : String(err) })),
  );
}

// Teach the harness's durable brain. Only ever called from an approved
// brain-update (an explicit human action), so this is the one place an
// approved fact becomes a learned pattern the harness reads back.
function appendToBrain(item: ReviewItem): void {
  if (!brainMemoryPath) return;
  const target = brainMemoryPath;
  // Curate the approved fact into the concise "fact, then Origin" pattern the
  // harness reads back — lead with the fact and collapse provenance (id,
  // reason, date) onto one line, so the durable brain stays low-noise as it
  // grows instead of carrying a metadata header per entry.
  const entry = [
    '',
    '## Approved fact',
    '',
    item.content || '[empty]',
    '',
    `Origin: approved brain-update ${item.id} — ${item.reason || 'no reason given'} · ${item.resolvedAt}`,
    '',
  ].join('\n');
  trackWrite(
    (async () => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await withFileLock(target, async () => {
        const existing = await fs.promises.readFile(target, 'utf-8').catch(() => '# Learned Patterns\n');
        // De-duplicate on approve: if the durable brain already holds this exact
        // fact (case/whitespace-insensitive), skip the write so repeated
        // approvals of the same claim do not bloat patterns.md. Conservative by
        // design — only a literal-text match is treated as a duplicate.
        const factText = (item.content || '').trim();
        if (factText && normalizeFact(existing).includes(normalizeFact(factText))) {
          logger.info('ReviewQueue', 'Skipped duplicate brain fact', { id: item.id });
          return;
        }
        await atomicWriteFile(target, existing.trimEnd() + '\n' + entry, { encoding: 'utf-8' });
      });
    })().catch((err) => logger.warn('ReviewQueue', 'Brain append failed', { error: err instanceof Error ? err.message : String(err) })),
  );
}

// Normalize a fact for duplicate detection: lowercase and collapse whitespace.
function normalizeFact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Append a drained needs-review answer to the durable replay seam. A replay /
// auto-research consumer reads this JSONL; this function does not run any loop.
function appendReplayCandidate(item: ReviewItem): void {
  if (!replayLogPath) return;
  const line = JSON.stringify({ id: item.id, content: item.content, reason: item.reason, drainedAt: item.resolvedAt }) + '\n';
  trackWrite(
    fs.promises.appendFile(replayLogPath, line, { encoding: 'utf-8', mode: 0o600 })
      .catch((err) => logger.warn('ReviewQueue', 'Replay-log append failed', { error: err instanceof Error ? err.message : String(err) })),
  );
}

function persist(): void {
  if (!storePath) return;
  const target = storePath;
  const snapshot = JSON.stringify(items, null, 2);
  trackWrite(
    withFileLock(target, () => atomicWriteFile(target, snapshot, { encoding: 'utf-8', mode: 0o600 }))
      .catch((err) => logger.warn('ReviewQueue', 'Persist failed', { error: err instanceof Error ? err.message : String(err) })),
  );
}

function isValidKind(k: unknown): k is ReviewItemKind {
  return k === 'brain-update' || k === 'needs-review';
}

function isValidStatus(s: unknown): s is ReviewItemStatus {
  return s === 'pending' || s === 'approved' || s === 'rejected' || s === 'drained';
}
