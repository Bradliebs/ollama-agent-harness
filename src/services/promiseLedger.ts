// Promise Ledger — tracks commitments the agent makes to the user.
//
// When the agent says "I'll remind you", "I'll check this", "I'll monitor",
// etc., a promise is recorded. The obligation checker verifies fulfilment
// and flags breaches. Storage: .harness/promises.jsonl (append-only).

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream } from 'fs';

// ─── Types ──────────────────────────────────────────────────────────

export type PromiseStatus = 'pending' | 'fulfilled' | 'failed' | 'expired' | 'cancelled';

export interface AgentPromise {
  promise_id: string;
  /** Natural-language commitment extracted from assistant output. */
  commitment: string;
  /** Optional service this promise belongs to. */
  service_id?: string;
  /** Optional automation job backing this promise. */
  schedule_id?: string;
  /** Capability required to fulfil (e.g. scheduler, email, browser). */
  capability_required?: string;
  status: PromiseStatus;
  /** ISO timestamp when next action is expected. */
  next_due_at?: string;
  /** ISO timestamp of last fulfilment. */
  last_fulfilled_at?: string;
  failure_count: number;
  /** Fallback message if fulfilment cannot occur. */
  fallback_message?: string;
  /** Session that created the promise. */
  session_id?: string;
  created_at: string;
  updated_at: string;
}

export interface PromiseBreachEvent {
  promise_id: string;
  breach_type: 'overdue' | 'capability_missing' | 'repeated_failure';
  detail: string;
  timestamp: string;
}

export interface ObligationCheckResult {
  total: number;
  pending: number;
  fulfilled: number;
  failed: number;
  expired: number;
  breaches: PromiseBreachEvent[];
}

// ─── Commitment detection ───────────────────────────────────────────

const COMMITMENT_PATTERNS = [
  /I(?:['\u2019]ll| will)\s+remind\s+you/i,
  /I(?:['\u2019]ll| will)\s+check\s+(?:this|that|on|in)\s+(?:every|daily|weekly|each|tomorrow|regularly|periodically)/i,
  /I(?:['\u2019]ll| will)\s+monitor\s+(?:this|that|it|the|your)/i,
  /I(?:['\u2019]ll| will)\s+send\s+you\s+(?:a\s+)?(?:reminder|report|update|notification|summary|alert)/i,
  /I(?:['\u2019]ll| will)\s+follow\s+up\s+(?:on|with|about|tomorrow|next|later)/i,
  /I(?:['\u2019]ll| will)\s+schedule\s+(?:a\s+)?(?:\w+\s+)?(?:check|reminder|job|task|scan|review|run)/i,
  /I(?:['\u2019]ll| will)\s+set\s+up\s+(?:a\s+)?(?:recurring|daily|weekly|scheduled|automated)/i,
  /I(?:['\u2019]ll| will)\s+(?:keep|continue)\s+(?:tracking|watching|monitoring)/i,
  /I(?:['\u2019]ll| will)\s+notify\s+you\s+(?:when|if|about|every)/i,
  /I(?:['\u2019]ll| will)\s+(?:send|deliver)\s+(?:a\s+)?(?:daily|weekly|regular)\s+(?:report|update|summary)/i,
  /I(?:['\u2019]ll| will)\s+update\s+you\s+(?:when|if|every|daily|weekly|regularly)/i,
  /I(?:['\u2019]ll| will)\s+run\s+(?:this|that|it|the)\s+(?:every|daily|weekly|each)/i,
];

/** Detect commitment language in assistant text. Returns matched phrases. */
export function detectCommitments(text: string): string[] {
  const found: string[] = [];
  for (const pattern of COMMITMENT_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      // Grab surrounding context (up to 80 chars after match)
      const start = m.index ?? 0;
      const end = Math.min(start + m[0].length + 80, text.length);
      const nextPeriod = text.indexOf('.', start);
      const snippet = text.slice(start, nextPeriod > start && nextPeriod < end ? nextPeriod + 1 : end).trim();
      found.push(snippet);
    }
  }
  return found;
}

// ─── Persistence ────────────────────────────────────────────────────

function ledgerPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'promises.jsonl');
}

export async function createPromise(
  projectDir: string,
  commitment: string,
  options?: Partial<Pick<AgentPromise, 'service_id' | 'schedule_id' | 'capability_required' | 'next_due_at' | 'fallback_message' | 'session_id'>>,
): Promise<AgentPromise> {
  const now = new Date().toISOString();
  const promise: AgentPromise = {
    promise_id: crypto.randomUUID(),
    commitment,
    service_id: options?.service_id,
    schedule_id: options?.schedule_id,
    capability_required: options?.capability_required,
    status: 'pending',
    next_due_at: options?.next_due_at,
    failure_count: 0,
    fallback_message: options?.fallback_message,
    session_id: options?.session_id,
    created_at: now,
    updated_at: now,
  };
  const fp = ledgerPath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.appendFile(fp, JSON.stringify(promise) + '\n', 'utf-8');
  return promise;
}

export async function listPromises(projectDir: string, filter?: { status?: PromiseStatus; service_id?: string }): Promise<AgentPromise[]> {
  const fp = ledgerPath(projectDir);
  try { await fs.access(fp); } catch { return []; }

  // Build latest state from append-only log (last write wins per promise_id)
  const map = new Map<string, AgentPromise>();
  const rl = readline.createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as AgentPromise;
      map.set(p.promise_id, p);
    } catch { /* skip corrupt lines */ }
  }

  let results = Array.from(map.values());
  if (filter?.status) results = results.filter((p) => p.status === filter.status);
  if (filter?.service_id) results = results.filter((p) => p.service_id === filter.service_id);
  return results.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function updatePromise(
  projectDir: string,
  promise_id: string,
  updates: Partial<Pick<AgentPromise, 'status' | 'last_fulfilled_at' | 'failure_count' | 'next_due_at' | 'fallback_message' | 'schedule_id'>>,
): Promise<AgentPromise | null> {
  const all = await listPromises(projectDir);
  const existing = all.find((p) => p.promise_id === promise_id);
  if (!existing) return null;

  const updated: AgentPromise = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };
  const fp = ledgerPath(projectDir);
  await fs.appendFile(fp, JSON.stringify(updated) + '\n', 'utf-8');
  return updated;
}

// ─── Obligation checker ─────────────────────────────────────────────

export async function checkObligations(
  projectDir: string,
  availableCapabilities?: Set<string>,
): Promise<ObligationCheckResult> {
  const all = await listPromises(projectDir);
  const now = new Date();
  const breaches: PromiseBreachEvent[] = [];

  for (const p of all) {
    if (p.status !== 'pending') continue;

    // Overdue check
    if (p.next_due_at && new Date(p.next_due_at) < now) {
      breaches.push({
        promise_id: p.promise_id,
        breach_type: 'overdue',
        detail: `Promise "${p.commitment}" was due at ${p.next_due_at}`,
        timestamp: now.toISOString(),
      });
    }

    // Capability check
    if (p.capability_required && availableCapabilities && !availableCapabilities.has(p.capability_required)) {
      breaches.push({
        promise_id: p.promise_id,
        breach_type: 'capability_missing',
        detail: `Capability "${p.capability_required}" required but not available`,
        timestamp: now.toISOString(),
      });
    }

    // Repeated failure check
    if (p.failure_count >= 3) {
      breaches.push({
        promise_id: p.promise_id,
        breach_type: 'repeated_failure',
        detail: `Promise "${p.commitment}" has failed ${p.failure_count} times`,
        timestamp: now.toISOString(),
      });
    }
  }

  return {
    total: all.length,
    pending: all.filter((p) => p.status === 'pending').length,
    fulfilled: all.filter((p) => p.status === 'fulfilled').length,
    failed: all.filter((p) => p.status === 'failed').length,
    expired: all.filter((p) => p.status === 'expired').length,
    breaches,
  };
}

/** Fulfilment shortcut: mark a promise as fulfilled now. */
export async function fulfilPromise(projectDir: string, promise_id: string): Promise<AgentPromise | null> {
  return updatePromise(projectDir, promise_id, {
    status: 'fulfilled',
    last_fulfilled_at: new Date().toISOString(),
  });
}

/** Failure shortcut: increment failure count, optionally mark as failed. */
export async function failPromise(projectDir: string, promise_id: string, markFailed = false): Promise<AgentPromise | null> {
  const all = await listPromises(projectDir);
  const existing = all.find((p) => p.promise_id === promise_id);
  if (!existing) return null;
  return updatePromise(projectDir, promise_id, {
    failure_count: existing.failure_count + 1,
    status: markFailed ? 'failed' : existing.status,
  });
}
