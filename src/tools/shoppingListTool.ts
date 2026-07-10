/**
 * shopping_list — durable, cross-channel grocery / errand list.
 *
 * The "executable layer" that pairs with the markdown-only
 * `shopping-assistant` SKILL. The skill is guidance the model loads on
 * trigger; this tool holds the actual state. Once registered, every
 * channel that runs through queryLoop (web chat, Telegram bot,
 * scheduled automation jobs) sees the same list with zero per-channel
 * wiring — that's the design point.
 *
 * Storage: <projectDir>/.harness/shopping/list.json (active items) and
 * <projectDir>/.harness/shopping/history.jsonl (append-only audit of
 * items marked bought). Path lives inside the workspace so the sandbox
 * mode's workspace-confinement applies for free via the same paths the
 * rest of `.harness/` uses.
 *
 * Concurrency: per-projectDir mutex chain — writes serialise, reads
 * race. Single-process server, no cross-process file locking needed.
 *
 * Corrupt JSON: treated as empty list, never throws to the caller.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

export interface ShoppingItem {
  /** Lowercase, trimmed — used for dedup matching. */
  name: string;
  /** Original casing as the user typed it; what's shown in `list` output. */
  displayName: string;
  /** Undefined means "unspecified count"; the model decides how to render. */
  quantity?: number;
  note?: string;
  /** ISO-8601 of first add (preserved across quantity bumps). */
  addedAt: string;
}

interface HistoryEntry extends ShoppingItem {
  boughtAt: string;
}

const writeChains = new Map<string, Promise<unknown>>();

function listPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'shopping', 'list.json');
}

function historyPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'shopping', 'history.jsonl');
}

async function readList(projectDir: string): Promise<ShoppingItem[]> {
  try {
    const raw = await fs.readFile(listPath(projectDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isShoppingItem);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    // Corrupt file — log and recover; never crash the agent loop.
    // eslint-disable-next-line no-console
    console.warn(`[shopping_list] failed to read ${listPath(projectDir)}: ${(err as Error).message}; treating as empty`);
    return [];
  }
}

function isShoppingItem(value: unknown): value is ShoppingItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.displayName === 'string' && typeof v.addedAt === 'string';
}

async function writeList(projectDir: string, items: ShoppingItem[]): Promise<void> {
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

/** Serialise mutating ops per projectDir. */
async function withWriteLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(projectDir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Swallow rejection on the chain so one failure doesn't block subsequent ops.
  writeChains.set(projectDir, next.catch(() => undefined));
  return next;
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(reason: string): ToolResult {
  return { success: false, output: reason, error: reason };
}

function normaliseName(input: string): string {
  return input.trim().toLowerCase();
}

function renderItem(item: ShoppingItem, index: number): string {
  const qty = typeof item.quantity === 'number' && item.quantity !== 1 ? ` (x${item.quantity})` : '';
  const note = item.note ? ` — ${item.note}` : '';
  return `${index + 1}. ${item.displayName}${qty}${note}`;
}

function findItem(items: ShoppingItem[], nameOrIndex: { name?: string; index?: number }): { item: ShoppingItem; idx: number } | null {
  if (typeof nameOrIndex.index === 'number') {
    const zeroBased = nameOrIndex.index - 1;
    if (zeroBased < 0 || zeroBased >= items.length) return null;
    return { item: items[zeroBased], idx: zeroBased };
  }
  if (nameOrIndex.name) {
    const needle = normaliseName(nameOrIndex.name);
    const idx = items.findIndex((it) => it.name === needle);
    if (idx < 0) return null;
    return { item: items[idx], idx };
  }
  return null;
}

export function createShoppingListTool(projectDir: string): Tool {
  return {
    name: 'shopping_list',
    description:
      'Manage a durable shopping / errand list shared across every channel (web chat, Telegram, scheduled jobs). ' +
      'Operations: add, list, remove, clear, mark_bought. ' +
      'Use this whenever the user mentions buying, needing, picking up, or running out of something — and when they ask what is on the list. ' +
      'The list is stored under .harness/shopping/ in the workspace; mark_bought archives items to history for later review.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'One of: add, list, remove, clear, mark_bought' },
        name: { type: 'string', description: 'Item name. Required for add; used by remove/mark_bought when index is not given.' },
        quantity: { type: 'number', description: 'For add: explicit count. If omitted and the item already exists, the existing count is bumped by 1.' },
        note: { type: 'string', description: 'For add: free-text note (e.g. brand, size). Appended to any existing note for the same item.' },
        index: { type: 'number', description: '1-based index from the most recent list output. Alternative to name for remove/mark_bought.' },
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
          case 'mark_bought':
            return await withWriteLock(projectDir, () => opMarkBought(projectDir, input));
          default:
            return fail(`shopping_list: unknown op '${op}'. Valid: add, list, remove, clear, mark_bought`);
        }
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        return fail(`shopping_list: ${reason}`);
      }
    },
  };
}

async function opList(projectDir: string): Promise<ToolResult> {
  const items = await readList(projectDir);
  if (items.length === 0) return ok('Shopping list is empty.');
  const lines = items.map((it, i) => renderItem(it, i));
  return ok(`Shopping list (${items.length} item${items.length === 1 ? '' : 's'}):\n${lines.join('\n')}`);
}

async function opAdd(projectDir: string, input: Record<string, unknown>): Promise<ToolResult> {
  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  if (!rawName) return fail('shopping_list: add requires `name`');
  const explicitQty = typeof input.quantity === 'number' && Number.isFinite(input.quantity) ? input.quantity : undefined;
  const newNote = typeof input.note === 'string' ? input.note.trim() : '';

  const items = await readList(projectDir);
  const key = normaliseName(rawName);
  const existingIdx = items.findIndex((it) => it.name === key);

  if (existingIdx >= 0) {
    const existing = items[existingIdx];
    const updated: ShoppingItem = { ...existing };
    if (explicitQty !== undefined) {
      updated.quantity = explicitQty;
    } else {
      updated.quantity = (existing.quantity ?? 1) + 1;
    }
    if (newNote) {
      updated.note = existing.note ? `${existing.note}; ${newNote}` : newNote;
    }
    items[existingIdx] = updated;
    await writeList(projectDir, items);
    return ok(`Updated: ${renderItem(updated, existingIdx)}`);
  }

  const item: ShoppingItem = {
    name: key,
    displayName: rawName,
    addedAt: new Date().toISOString(),
  };
  if (explicitQty !== undefined) item.quantity = explicitQty;
  if (newNote) item.note = newNote;
  items.push(item);
  await writeList(projectDir, items);
  return ok(`Added: ${renderItem(item, items.length - 1)}`);
}

async function opRemove(projectDir: string, input: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : undefined;
  const index = typeof input.index === 'number' ? input.index : undefined;
  if (!name && index === undefined) return fail('shopping_list: remove requires `name` or `index`');

  const items = await readList(projectDir);
  const found = findItem(items, { name, index });
  if (!found) return fail(`shopping_list: no item matched ${name ? `name '${name}'` : `index ${index}`}`);
  items.splice(found.idx, 1);
  await writeList(projectDir, items);
  return ok(`Removed: ${found.item.displayName}`);
}

async function opClear(projectDir: string): Promise<ToolResult> {
  const items = await readList(projectDir);
  const count = items.length;
  await writeList(projectDir, []);
  return ok(count === 0 ? 'Shopping list was already empty.' : `Cleared ${count} item${count === 1 ? '' : 's'}.`);
}

async function opMarkBought(projectDir: string, input: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : undefined;
  const index = typeof input.index === 'number' ? input.index : undefined;
  if (!name && index === undefined) return fail('shopping_list: mark_bought requires `name` or `index`');

  const items = await readList(projectDir);
  const found = findItem(items, { name, index });
  if (!found) return fail(`shopping_list: no item matched ${name ? `name '${name}'` : `index ${index}`}`);
  const archived: HistoryEntry = { ...found.item, boughtAt: new Date().toISOString() };
  items.splice(found.idx, 1);
  await appendHistory(projectDir, archived);
  await writeList(projectDir, items);
  return ok(`Marked bought: ${found.item.displayName}`);
}
