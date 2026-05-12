// Per-skill usage metadata, persisted in .harness/skill-usage.json so the
// Curator has something to grade staleness on. Also tracks pin (curator may
// not touch) and archive (skill moved out of the active library).
//
// Kept as a single JSON file rather than a sidecar per skill so the Curator
// can scan the whole library cheaply and so manual edits stay easy to review.

import * as fs from 'fs/promises';
import * as path from 'path';

export interface SkillUsageRecord {
  /** Skill name (matches SKILL.md frontmatter `name`). */
  name: string;
  /** ISO timestamp of the last time the skill was used (executed by an agent). */
  lastUsedAt?: string;
  /** ISO timestamp of the last time the skill was viewed (opened in UI / list_skills surfaced it). */
  lastViewedAt?: string;
  /** Number of times the agent has executed this skill. */
  useCount: number;
  /** Number of times the skill has appeared in a list / been viewed. */
  viewCount: number;
  /** When true, the Curator must not archive or merge this skill. */
  pinned: boolean;
  /** When true, the skill was moved to .harness/skills/_archive/. Curator can still see it for analysis. */
  archived: boolean;
  /** ISO timestamp when the skill was created (best-effort, populated lazily). */
  firstSeenAt: string;
  /** ISO timestamp the record was last written. */
  updatedAt: string;
}

export interface SkillUsageStore {
  version: 1;
  records: Record<string, SkillUsageRecord>;
}

function usageFilePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'skill-usage.json');
}

export async function loadSkillUsage(projectDir: string): Promise<SkillUsageStore> {
  try {
    const raw = await fs.readFile(usageFilePath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as SkillUsageStore;
    if (parsed.version !== 1 || typeof parsed.records !== 'object' || parsed.records === null) {
      return { version: 1, records: {} };
    }
    return parsed;
  } catch {
    return { version: 1, records: {} };
  }
}

export async function saveSkillUsage(projectDir: string, store: SkillUsageStore): Promise<void> {
  await fs.mkdir(path.dirname(usageFilePath(projectDir)), { recursive: true });
  await fs.writeFile(usageFilePath(projectDir), JSON.stringify(store, null, 2), 'utf-8');
}

function ensureRecord(store: SkillUsageStore, name: string, now: string): SkillUsageRecord {
  let record = store.records[name];
  if (!record) {
    record = { name, useCount: 0, viewCount: 0, pinned: false, archived: false, firstSeenAt: now, updatedAt: now };
    store.records[name] = record;
  }
  return record;
}

export async function recordSkillView(projectDir: string, name: string, now: Date = new Date()): Promise<SkillUsageRecord> {
  const store = await loadSkillUsage(projectDir);
  const iso = now.toISOString();
  const record = ensureRecord(store, name, iso);
  record.viewCount += 1;
  record.lastViewedAt = iso;
  record.updatedAt = iso;
  await saveSkillUsage(projectDir, store);
  return record;
}

export async function recordSkillUse(projectDir: string, name: string, now: Date = new Date()): Promise<SkillUsageRecord> {
  const store = await loadSkillUsage(projectDir);
  const iso = now.toISOString();
  const record = ensureRecord(store, name, iso);
  record.useCount += 1;
  record.lastUsedAt = iso;
  record.updatedAt = iso;
  await saveSkillUsage(projectDir, store);
  return record;
}

export async function setSkillPinned(projectDir: string, name: string, pinned: boolean, now: Date = new Date()): Promise<SkillUsageRecord> {
  const store = await loadSkillUsage(projectDir);
  const iso = now.toISOString();
  const record = ensureRecord(store, name, iso);
  record.pinned = pinned;
  record.updatedAt = iso;
  await saveSkillUsage(projectDir, store);
  return record;
}

export async function setSkillArchived(projectDir: string, name: string, archived: boolean, now: Date = new Date()): Promise<SkillUsageRecord> {
  const store = await loadSkillUsage(projectDir);
  const iso = now.toISOString();
  const record = ensureRecord(store, name, iso);
  record.archived = archived;
  record.updatedAt = iso;
  await saveSkillUsage(projectDir, store);
  return record;
}

export async function listSkillUsage(projectDir: string): Promise<SkillUsageRecord[]> {
  const store = await loadSkillUsage(projectDir);
  return Object.values(store.records);
}

export async function getSkillUsage(projectDir: string, name: string): Promise<SkillUsageRecord | undefined> {
  const store = await loadSkillUsage(projectDir);
  return store.records[name];
}
