/**
 * Morning Priority store.
 *
 * Persists a single "top priority for today" answer per day under
 * `.harness/priorities/<YYYY-MM-DD>.json`. The 9am trigger reads
 * today's file to decide whether to surface the prompt and, if the
 * user replies via chat / Telegram, the chat handler calls
 * `setPriorityForToday` to store the answer.
 *
 * Read by `composeDailyBrief` via `loadMorningPriorityInputs` so the
 * brief opens with the day's anchor question.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { MorningPriorityInputs } from '../jarvis/dailyBrief';

export interface StoredPriority {
  date: string;        // YYYY-MM-DD
  answer?: string;
  setAt?: string;      // ISO timestamp when answer was recorded
  askedAt?: string;    // ISO timestamp when the prompt was last shown
}

function priorityDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'priorities');
}

function priorityFile(projectDir: string, date: string): string {
  return path.join(priorityDir(projectDir), `${date}.json`);
}

export function todayDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function readPriority(projectDir: string, date: string): Promise<StoredPriority | null> {
  try {
    const raw = await fs.readFile(priorityFile(projectDir, date), 'utf-8');
    return JSON.parse(raw) as StoredPriority;
  } catch {
    return null;
  }
}

async function writePriority(projectDir: string, p: StoredPriority): Promise<void> {
  await fs.mkdir(priorityDir(projectDir), { recursive: true });
  await fs.writeFile(priorityFile(projectDir, p.date), JSON.stringify(p, null, 2), 'utf-8');
}

/** Set today's top priority. */
export async function setPriorityForToday(projectDir: string, answer: string, now: Date = new Date()): Promise<StoredPriority> {
  const date = todayDate(now);
  const existing = (await readPriority(projectDir, date)) ?? { date };
  const stored: StoredPriority = { ...existing, date, answer: answer.trim(), setAt: now.toISOString() };
  await writePriority(projectDir, stored);
  return stored;
}

/** Record that the prompt was shown today (so the trigger can dedupe). */
export async function markPromptShown(projectDir: string, now: Date = new Date()): Promise<StoredPriority> {
  const date = todayDate(now);
  const existing = (await readPriority(projectDir, date)) ?? { date };
  const stored: StoredPriority = { ...existing, date, askedAt: now.toISOString() };
  await writePriority(projectDir, stored);
  return stored;
}

/** Read today's priority (or null if unset). */
export async function getPriorityForToday(projectDir: string, now: Date = new Date()): Promise<StoredPriority | null> {
  return readPriority(projectDir, todayDate(now));
}

/** List recent priorities, newest-first, capped. */
export async function listRecentPriorities(projectDir: string, limit = 7): Promise<StoredPriority[]> {
  const dir = priorityDir(projectDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  const out: StoredPriority[] = [];
  for (const file of files.slice(0, limit)) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      out.push(JSON.parse(raw) as StoredPriority);
    } catch {
      // skip unreadable file
    }
  }
  return out;
}

/**
 * Produce the `MorningPriorityInputs` shape consumed by composeDailyBrief.
 * Returns null when the file does not exist and there's nothing to show.
 */
export async function loadMorningPriorityInputs(projectDir: string, now: Date = new Date()): Promise<MorningPriorityInputs | null> {
  const date = todayDate(now);
  const today = await readPriority(projectDir, date);
  const recent = await listRecentPriorities(projectDir, 6);
  const filteredRecent = recent
    .filter((p) => p.date !== date && p.answer)
    .map((p) => ({ date: p.date, answer: p.answer! }));

  if (!today && filteredRecent.length === 0) return null;

  return {
    forDate: date,
    answer: today?.answer,
    recentPriorities: filteredRecent,
  };
}

/**
 * Recognise a chat message that sets today's priority. Returns the
 * extracted answer string when matched, else null.
 *
 * Accepts (case-insensitive):
 *   priority: deploy v2 to prod
 *   /priority deploy v2 to prod
 *   top priority: deploy v2 to prod
 */
export function parsePrioritySetCommand(message: string): string | null {
  const trimmed = message.trim();
  // /priority allows space or colon; "priority" and "top priority" require a colon.
  const m = trimmed.match(/^(?:\/priority[:\s]+|(?:top\s+)?priority\s*:\s*)(.+)$/i);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}
