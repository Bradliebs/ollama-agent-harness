/**
 * reading_list — durable, cross-channel reading queue.
 *
 * Second application of the "shopping-list-shaped" recipe captured in
 * /memories/session/plan.md. Same architectural shape as
 * src/tools/shoppingListTool.ts: factory + single-tool-with-op +
 * per-projectDir mutex + atomic writes + corrupt-JSON recovery.
 * Validates that the pattern generalises beyond the first instance.
 *
 * Domain adaptations:
 *   - No quantity (3x of the same book doesn't mean anything).
 *   - Dedup MERGES fields on re-add (e.g. add a URL to a title-only
 *     entry) instead of bumping a counter.
 *   - Dedup key prefers URL (normalised lowercase) when present, else
 *     normalised title. Re-adding the same URL with a different title
 *     updates the display name (so "I learned the real title later"
 *     works).
 *
 * Storage: <projectDir>/.harness/reading/list.json (queue) and
 * <projectDir>/.harness/reading/history.jsonl (mark_read archive).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

export interface ReadingItem {
  /** Dedup key: lowercased URL if present, else lowercased trimmed title. */
  key: string;
  /** What gets shown in `list` output. */
  displayName: string;
  url?: string;
  author?: string;
  note?: string;
  /** ISO-8601 of first add (preserved across merges). */
  addedAt: string;
}

interface HistoryEntry extends ReadingItem {
  readAt: string;
}

const writeChains = new Map<string, Promise<unknown>>();

function listPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'reading', 'list.json');
}

function historyPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'reading', 'history.jsonl');
}

async function readList(projectDir: string): Promise<ReadingItem[]> {
  try {
    const raw = await fs.readFile(listPath(projectDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReadingItem);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    // eslint-disable-next-line no-console
    console.warn(`[reading_list] failed to read ${listPath(projectDir)}: ${(err as Error).message}; treating as empty`);
    return [];
  }
}

function isReadingItem(value: unknown): value is ReadingItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === 'string' && typeof v.displayName === 'string' && typeof v.addedAt === 'string';
}

async function writeList(projectDir: string, items: ReadingItem[]): Promise<void> {
  const target = listPath(projectDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

async function appendHistory(projectDir: string, entry: HistoryEntry): Promise<void> {
  const target = historyPath(projectDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, JSON.stringify(entry) + '\n', 'utf8');
}

async function withWriteLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(projectDir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(projectDir, next.catch(() => undefined));
  return next;
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(reason: string): ToolResult {
  return { success: false, output: reason, error: reason };
}

function normalise(input: string): string {
  return input.trim().toLowerCase();
}

function deriveKey(title: string, url?: string): string {
  if (url && url.trim()) return normalise(url);
  return normalise(title);
}

function renderItem(item: ReadingItem, index: number): string {
  const author = item.author ? ` — ${item.author}` : '';
  const url = item.url ? ` [${item.url}]` : '';
  const note = item.note ? ` (${item.note})` : '';
  return `${index + 1}. ${item.displayName}${author}${url}${note}`;
}

function findItem(items: ReadingItem[], nameOrIndex: { name?: string; index?: number }): { item: ReadingItem; idx: number } | null {
  if (typeof nameOrIndex.index === 'number') {
    const zeroBased = nameOrIndex.index - 1;
    if (zeroBased < 0 || zeroBased >= items.length) return null;
    return { item: items[zeroBased], idx: zeroBased };
  }
  if (nameOrIndex.name) {
    const needle = normalise(nameOrIndex.name);
    // Match by display-name substring or by exact key.
    const idx = items.findIndex((it) => it.key === needle || normalise(it.displayName).includes(needle));
    if (idx < 0) return null;
    return { item: items[idx], idx };
  }
  return null;
}

export function createReadingListTool(projectDir: string): Tool {
  return {
    name: 'reading_list',
    description:
      'Manage a durable reading queue (books, papers, articles) shared across every channel (web chat, Telegram, scheduled jobs). ' +
      'Operations: add, list, remove, clear, mark_read. ' +
      'Use this whenever the user mentions saving something to read later, wants to know what is in their queue, or finishes a piece. ' +
      'Stored under .harness/reading/ in the workspace; mark_read archives items to history for later review.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'One of: add, list, remove, clear, mark_read' },
        title: { type: 'string', description: 'For add: human-readable title. For remove/mark_read: title (or substring of it) when index is not given.' },
        url: { type: 'string', description: 'For add: source URL. Used as the dedup key when present.' },
        author: { type: 'string', description: 'For add: author or byline. Optional.' },
        note: { type: 'string', description: 'For add: free-text note (why save it, what to focus on). Appended to any existing note with "; ".' },
        index: { type: 'number', description: '1-based index from the most recent list output. Alternative to title for remove/mark_read.' },
      },
      required: ['op'],
    },
    isReadOnly: false,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const op = typeof input.op === 'string' ? input.op : '';
      try {
        switch (op) {
          case 'list':
            return await opList(projectDir);
          case 'add':
            return await withWriteLock(projectDir, () => opAdd(projectDir, input));
          case 'remove':
            return await withWriteLock(projectDir, () => opRemove(projectDir, input));
          case 'clear':
            return await withWriteLock(projectDir, () => opClear(projectDir));
          case 'mark_read':
            return await withWriteLock(projectDir, () => opMarkRead(projectDir, input));
          default:
            return fail(`reading_list: unknown op '${op}'. Valid: add, list, remove, clear, mark_read`);
        }
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        return fail(`reading_list: ${reason}`);
      }
    },
  };
}

async function opList(projectDir: string): Promise<ToolResult> {
  const items = await readList(projectDir);
  if (items.length === 0) return ok('Reading list is empty.');
  const lines = items.map((it, i) => renderItem(it, i));
  return ok(`Reading list (${items.length} item${items.length === 1 ? '' : 's'}):\n${lines.join('\n')}`);
}

async function opAdd(projectDir: string, input: Record<string, unknown>): Promise<ToolResult> {
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  if (!rawTitle && !rawUrl) return fail('reading_list: add requires `title` or `url`');

  const author = typeof input.author === 'string' ? input.author.trim() : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  // If only URL is given, use the URL itself as the display until the user (or a later add) supplies a real title.
  const displayName = rawTitle || rawUrl;
  const key = deriveKey(rawTitle, rawUrl || undefined);

  const items = await readList(projectDir);
  const existingIdx = items.findIndex((it) => it.key === key);

  if (existingIdx >= 0) {
    const existing = items[existingIdx];
    const updated: ReadingItem = { ...existing };
    // Prefer a real title over a placeholder URL-as-title.
    if (rawTitle && (existing.displayName === existing.url || !existing.displayName)) {
      updated.displayName = rawTitle;
    } else if (rawTitle && rawTitle !== existing.displayName) {
      updated.displayName = rawTitle;
    }
    if (rawUrl && !existing.url) updated.url = rawUrl;
    if (author && !existing.author) updated.author = author;
    if (note) updated.note = existing.note ? `${existing.note}; ${note}` : note;
    items[existingIdx] = updated;
    await writeList(projectDir, items);
    return ok(`Updated: ${renderItem(updated, existingIdx)}`);
  }

  const item: ReadingItem = {
    key,
    displayName,
    addedAt: new Date().toISOString(),
  };
  if (rawUrl) item.url = rawUrl;
  if (author) item.author = author;
  if (note) item.note = note;
  items.push(item);
  await writeList(projectDir, items);
  return ok(`Added: ${renderItem(item, items.length - 1)}`);
}

async function opRemove(projectDir: string, input: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof input.title === 'string' ? input.title : undefined;
  const index = typeof input.index === 'number' ? input.index : undefined;
  if (!name && index === undefined) return fail('reading_list: remove requires `title` or `index`');

  const items = await readList(projectDir);
  const found = findItem(items, { name, index });
  if (!found) return fail(`reading_list: no item matched ${name ? `title '${name}'` : `index ${index}`}`);
  items.splice(found.idx, 1);
  await writeList(projectDir, items);
  return ok(`Removed: ${found.item.displayName}`);
}

async function opClear(projectDir: string): Promise<ToolResult> {
  const items = await readList(projectDir);
  const count = items.length;
  await writeList(projectDir, []);
  return ok(count === 0 ? 'Reading list was already empty.' : `Cleared ${count} item${count === 1 ? '' : 's'}.`);
}

async function opMarkRead(projectDir: string, input: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof input.title === 'string' ? input.title : undefined;
  const index = typeof input.index === 'number' ? input.index : undefined;
  if (!name && index === undefined) return fail('reading_list: mark_read requires `title` or `index`');

  const items = await readList(projectDir);
  const found = findItem(items, { name, index });
  if (!found) return fail(`reading_list: no item matched ${name ? `title '${name}'` : `index ${index}`}`);
  const archived: HistoryEntry = { ...found.item, readAt: new Date().toISOString() };
  items.splice(found.idx, 1);
  await appendHistory(projectDir, archived);
  await writeList(projectDir, items);
  return ok(`Marked read: ${found.item.displayName}`);
}
