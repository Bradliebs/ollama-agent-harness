// Identity layer.
//
// Three persistent files under `.harness/identity/`:
//   - SOUL.md        — long-term agent personality / values
//   - USER.md        — long-term notes about the user
//   - structured.json — queryable people / projects / preferences / facts
//
// All operations are best-effort and idempotent. Missing files yield empty
// strings or empty objects rather than errors so callers can render a
// "nothing here yet" state.

import * as fs from 'fs/promises';
import * as path from 'path';

export type IdentityFileName = 'SOUL.md' | 'USER.md';

export interface StructuredEntry {
  id: string;
  category: string;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StructuredStore {
  version: 1;
  entries: StructuredEntry[];
}

export interface IdentitySnapshot {
  soul: string;
  user: string;
  structured: StructuredStore;
}

const DEFAULT_SOUL = `# Soul

Long-term identity, voice, and values for the harness agent. Edit freely
— the agent reads this whenever it answers, so anything written here
shapes how it behaves over time.
`;

const DEFAULT_USER = `# User

Long-term notes about the user (preferences, working style, common
projects). The agent updates this file as it learns.
`;

function identityDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'identity');
}

function identityFilePath(projectDir: string, fileName: IdentityFileName): string {
  return path.join(identityDir(projectDir), fileName);
}

function structuredFilePath(projectDir: string): string {
  return path.join(identityDir(projectDir), 'structured.json');
}

export async function readIdentitySnapshot(projectDir: string): Promise<IdentitySnapshot> {
  const [soul, user, structured] = await Promise.all([
    readIdentityFile(projectDir, 'SOUL.md'),
    readIdentityFile(projectDir, 'USER.md'),
    readStructuredStore(projectDir),
  ]);
  return { soul, user, structured };
}

export async function readIdentityFile(projectDir: string, fileName: IdentityFileName): Promise<string> {
  try {
    return await fs.readFile(identityFilePath(projectDir, fileName), 'utf-8');
  } catch {
    return fileName === 'SOUL.md' ? DEFAULT_SOUL : DEFAULT_USER;
  }
}

export async function writeIdentityFile(projectDir: string, fileName: IdentityFileName, content: string): Promise<void> {
  const fp = identityFilePath(projectDir, fileName);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, content, 'utf-8');
}

export async function readStructuredStore(projectDir: string): Promise<StructuredStore> {
  try {
    const raw = await fs.readFile(structuredFilePath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StructuredStore>;
    return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isEntryLike) : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

export interface UpsertStructuredInput {
  id?: string;
  category: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function upsertStructuredEntry(
  projectDir: string,
  input: UpsertStructuredInput,
  now = new Date(),
): Promise<StructuredEntry> {
  const store = await readStructuredStore(projectDir);
  const id = (input.id ?? slugifyId(input.category, input.summary)).slice(0, 80);
  if (!id) throw new Error('Cannot derive an id from the input.');
  const existingIdx = store.entries.findIndex((entry) => entry.id === id);
  const isoNow = now.toISOString();
  const next: StructuredEntry = existingIdx === -1
    ? { id, category: input.category, summary: input.summary, metadata: input.metadata, createdAt: isoNow, updatedAt: isoNow }
    : { ...store.entries[existingIdx], category: input.category, summary: input.summary, metadata: input.metadata, updatedAt: isoNow };
  if (existingIdx === -1) store.entries.push(next);
  else store.entries[existingIdx] = next;
  await writeStructuredStore(projectDir, store);
  return next;
}

export async function deleteStructuredEntry(projectDir: string, id: string): Promise<boolean> {
  const store = await readStructuredStore(projectDir);
  const idx = store.entries.findIndex((entry) => entry.id === id);
  if (idx === -1) return false;
  store.entries.splice(idx, 1);
  await writeStructuredStore(projectDir, store);
  return true;
}

export async function queryStructured(projectDir: string, filter: { category?: string; q?: string } = {}): Promise<StructuredEntry[]> {
  const store = await readStructuredStore(projectDir);
  const q = filter.q ? filter.q.toLowerCase() : '';
  return store.entries.filter((entry) => {
    if (filter.category && entry.category !== filter.category) return false;
    if (q) {
      const haystack = (entry.summary + ' ' + entry.id + ' ' + entry.category).toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Build a compact identity context block suitable for inclusion in a system
 * prompt. Returns an empty string when nothing is configured so it can be
 * concatenated unconditionally.
 */
export async function renderIdentityForPrompt(projectDir: string, options: { maxChars?: number } = {}): Promise<string> {
  const snapshot = await readIdentitySnapshot(projectDir);
  const maxChars = options.maxChars ?? 4000;
  const parts: string[] = [];
  const soulTrim = stripDefaults(snapshot.soul, DEFAULT_SOUL);
  const userTrim = stripDefaults(snapshot.user, DEFAULT_USER);
  if (soulTrim) parts.push(`## Soul\n${soulTrim}`);
  if (userTrim) parts.push(`## User\n${userTrim}`);
  if (snapshot.structured.entries.length > 0) {
    const lines = snapshot.structured.entries
      .slice(0, 32)
      .map((entry) => `- [${entry.category}] ${entry.summary}`);
    parts.push(`## Structured facts\n${lines.join('\n')}`);
  }
  if (parts.length === 0) return '';
  let output = `# Identity\n${parts.join('\n\n')}`;
  if (output.length > maxChars) output = output.slice(0, maxChars) + `\n…[truncated to ${maxChars} chars]`;
  return output;
}

async function writeStructuredStore(projectDir: string, store: StructuredStore): Promise<void> {
  const fp = structuredFilePath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(store, null, 2), 'utf-8');
}

function isEntryLike(value: unknown): value is StructuredEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.category === 'string' && typeof v.summary === 'string';
}

function stripDefaults(content: string, defaultContent: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (trimmed === defaultContent.trim()) return '';
  return trimmed;
}

function slugifyId(category: string, summary: string): string {
  return (category + '-' + summary).toLowerCase().replace(/[^a-z0-9-_ ]+/g, '').replace(/\s+/g, '-').slice(0, 80);
}

// ─── Import / Export ────────────────────────────────────────────────

export interface IdentityExport {
  version: 1;
  exportedAt: string;
  snapshot: IdentitySnapshot;
}

export async function exportIdentity(projectDir: string): Promise<IdentityExport> {
  const snapshot = await readIdentitySnapshot(projectDir);
  return { version: 1, exportedAt: new Date().toISOString(), snapshot };
}

export interface ImportIdentityOptions {
  /** When true (default), structured entries are merged on id; when false, the existing structured store is replaced. */
  mergeStructured?: boolean;
  /** When true, SOUL.md / USER.md are overwritten only if the import payload contains a non-empty value. */
  overwriteFiles?: boolean;
}

export interface ImportIdentitySummary {
  importedSoul: boolean;
  importedUser: boolean;
  importedStructured: number;
  skippedStructured: number;
}

export async function importIdentity(
  projectDir: string,
  payload: unknown,
  options: ImportIdentityOptions = {},
): Promise<ImportIdentitySummary> {
  if (!payload || typeof payload !== 'object') throw new Error('payload must be an object');
  const value = payload as Partial<IdentityExport> & { snapshot?: Partial<IdentitySnapshot> };
  const snapshot = value.snapshot;
  if (!snapshot || typeof snapshot !== 'object') throw new Error('payload.snapshot is required');
  const summary: ImportIdentitySummary = { importedSoul: false, importedUser: false, importedStructured: 0, skippedStructured: 0 };
  const overwriteFiles = options.overwriteFiles !== false;

  if (overwriteFiles && typeof snapshot.soul === 'string' && snapshot.soul.trim().length > 0) {
    await writeIdentityFile(projectDir, 'SOUL.md', snapshot.soul);
    summary.importedSoul = true;
  }
  if (overwriteFiles && typeof snapshot.user === 'string' && snapshot.user.trim().length > 0) {
    await writeIdentityFile(projectDir, 'USER.md', snapshot.user);
    summary.importedUser = true;
  }

  const incoming = snapshot.structured && Array.isArray(snapshot.structured.entries) ? snapshot.structured.entries.filter(isEntryLike) : [];
  if (options.mergeStructured === false) {
    // Replace mode: write the incoming list verbatim (after sanitising).
    const next: StructuredStore = { version: 1, entries: incoming };
    await writeStructuredStore(projectDir, next);
    summary.importedStructured = incoming.length;
  } else {
    // Merge mode (default): upsert each entry; existing entries with the
    // same id are updated, new ids are added.
    for (const entry of incoming) {
      try {
        await upsertStructuredEntry(projectDir, { id: entry.id, category: entry.category, summary: entry.summary, metadata: entry.metadata });
        summary.importedStructured += 1;
      } catch {
        summary.skippedStructured += 1;
      }
    }
  }
  return summary;
}

// ─── Garbage collection ─────────────────────────────────────────────

export interface IdentityGcOptions {
  /** Drop entries older than this many days. Defaults to 90. */
  maxAgeDays?: number;
}

export interface IdentityGcSummary {
  scanned: number;
  removed: number;
  pinnedKept: number;
}

/**
 * Drop structured entries that have not been updated in `maxAgeDays`. Entries
 * with `metadata.pinned === true` are always kept regardless of age.
 */
export async function runIdentityGc(projectDir: string, options: IdentityGcOptions = {}, now = new Date()): Promise<IdentityGcSummary> {
  const maxAgeDays = options.maxAgeDays ?? 90;
  const thresholdMs = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const store = await readStructuredStore(projectDir);
  let removed = 0;
  let pinnedKept = 0;
  const kept: StructuredEntry[] = [];
  for (const entry of store.entries) {
    const isPinned = entry.metadata && (entry.metadata as Record<string, unknown>).pinned === true;
    if (isPinned) {
      pinnedKept += 1;
      kept.push(entry);
      continue;
    }
    const updated = Date.parse(entry.updatedAt);
    if (Number.isFinite(updated) && updated < thresholdMs) {
      removed += 1;
      continue;
    }
    kept.push(entry);
  }
  if (removed > 0) {
    await writeStructuredStore(projectDir, { version: 1, entries: kept });
  }
  return { scanned: store.entries.length, removed, pinnedKept };
}
