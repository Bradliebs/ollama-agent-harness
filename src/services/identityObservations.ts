// Identity observations — gathers recent session transcripts into the
// flat text the proposal layer reasons about.
//
// Why session transcripts: they're already the durable, structured
// record of every interaction. Filtering by SessionMeta.updatedAt lets
// us read only what's new since the last identity pass without any new
// persistence layer.
//
// Tool calls are skipped — they're noisy for personality drift and the
// user-visible signal lives in messages.

import { SessionStorage } from '../persistence/sessionStorage';
import type { SessionEvent, SessionMeta } from '../types';

export interface ObservationsResult {
  /** Flat observation text suitable for the proposal prompt. Empty when nothing relevant was found. */
  text: string;
  /** Number of session files inspected. */
  sessionsRead: number;
  /** Number of message events included. */
  messagesIncluded: number;
  /** The lower bound used to filter sessions, ms since epoch. */
  sinceMs: number;
}

export interface ObservationsOptions {
  /** Sessions with updatedAt at or after this timestamp are included. Defaults to 24h ago. */
  sinceMs?: number;
  /** Hard cap on output length. Defaults to 16000 chars. */
  maxChars?: number;
  /** Per-message truncation. Defaults to 600 chars. */
  maxCharsPerMessage?: number;
  /** Override clock for tests. */
  now?: Date;
}

const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 600;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Pulls user + assistant messages from sessions updated since `sinceMs`.
 * Most recent sessions first; within a session, messages stay in
 * chronological order. Output is capped at `maxChars` and per-message
 * content is truncated to `maxCharsPerMessage`.
 */
export async function gatherIdentityObservations(
  projectDir: string,
  options: ObservationsOptions = {},
): Promise<ObservationsResult> {
  const now = options.now ?? new Date();
  const sinceMs = options.sinceMs ?? now.getTime() - DEFAULT_LOOKBACK_MS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE;
  const all = await SessionStorage.listSessions(projectDir);
  const fresh = all
    .filter((meta) => parseUpdatedAtMs(meta) >= sinceMs)
    .sort((a, b) => parseUpdatedAtMs(b) - parseUpdatedAtMs(a));
  if (fresh.length === 0) {
    return { text: '', sessionsRead: 0, messagesIncluded: 0, sinceMs };
  }
  const blocks: string[] = [];
  let totalChars = 0;
  let messagesIncluded = 0;
  let sessionsRead = 0;
  for (const meta of fresh) {
    if (totalChars >= maxChars) break;
    sessionsRead += 1;
    const storage = new SessionStorage(projectDir, meta.model, meta.sessionId);
    let events: SessionEvent[];
    try {
      events = await storage.readAll();
    } catch {
      continue;
    }
    const lines: string[] = [];
    for (const event of events) {
      if (event.data.kind !== 'message') continue;
      const role = event.data.message.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const raw = (event.data.message.content ?? '').trim();
      if (!raw) continue;
      const truncated = raw.length > maxCharsPerMessage
        ? raw.slice(0, maxCharsPerMessage) + '…'
        : raw;
      lines.push(`[${role}] ${truncated}`);
      messagesIncluded += 1;
    }
    if (lines.length === 0) continue;
    const header = `--- session ${meta.sessionId.slice(0, 8)} (updated ${meta.updatedAt ?? meta.createdAt}) ---`;
    const block = [header, ...lines].join('\n');
    if (totalChars + block.length + 1 > maxChars) {
      const remaining = maxChars - totalChars - 1;
      if (remaining > header.length + 8) {
        blocks.push(block.slice(0, remaining) + '…');
        totalChars = maxChars;
      }
      break;
    }
    blocks.push(block);
    totalChars += block.length + 1;
  }
  return {
    text: blocks.join('\n\n'),
    sessionsRead,
    messagesIncluded,
    sinceMs,
  };
}

function parseUpdatedAtMs(meta: SessionMeta): number {
  const stamp = meta.updatedAt ?? meta.createdAt;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : 0;
}
