// Per-skill usage metadata, persisted in .harness/skill-usage.json so the
// Curator has something to grade staleness on. Also tracks pin (curator may
// not touch) and archive (skill moved out of the active library).
//
// Kept as a single JSON file rather than a sidecar per skill so the Curator
// can scan the whole library cheaply and so manual edits stay easy to review.

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';

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
  /** Runs that used the skill and completed cleanly, or did not (learning/lessons.ts). */
  successCount?: number;
  failureCount?: number;
  consecutiveFailures?: number;
  lastOutcomeAt?: string;
  /**
   * probation: written by the agent and not yet proven; becomes proven after
   * PROBATION_SUCCESSES clean runs. Absent for skills a person wrote or installed.
   */
  status?: 'probation' | 'proven';
  /** Increments each time the agent rewrites the skill. */
  version?: number;
}

/** Clean runs a probation skill needs before it counts as proven. */
export const PROBATION_SUCCESSES = 3;

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
  // Atomic so readers (skill tools, curator) never see a half-written file.
  await atomicWriteFile(usageFilePath(projectDir), JSON.stringify(store, null, 2), { encoding: 'utf-8' });
}

/**
 * Read-modify-write one record under a file lock. The skill tools record
 * views and uses fire-and-forget while post-run learning records outcomes,
 * so unlocked writers would drop each other's updates.
 */
async function updateRecord(projectDir: string, name: string, now: Date, mutate: (record: SkillUsageRecord, iso: string) => void): Promise<SkillUsageRecord> {
  await fs.mkdir(path.dirname(usageFilePath(projectDir)), { recursive: true });
  return withFileLock(path.resolve(usageFilePath(projectDir)), async () => {
    const store = await loadSkillUsage(projectDir);
    const iso = now.toISOString();
    const record = ensureRecord(store, name, iso);
    mutate(record, iso);
    await saveSkillUsage(projectDir, store);
    return record;
  });
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
  return updateRecord(projectDir, name, now, (record, iso) => {
    record.viewCount += 1;
    record.lastViewedAt = iso;
    record.updatedAt = iso;
  });
}

export async function recordSkillUse(projectDir: string, name: string, now: Date = new Date()): Promise<SkillUsageRecord> {
  return updateRecord(projectDir, name, now, (record, iso) => {
    record.useCount += 1;
    record.lastUsedAt = iso;
    record.updatedAt = iso;
  });
}

/** Record whether a run that used the skill completed cleanly. */
export async function recordSkillOutcome(projectDir: string, name: string, success: boolean, now: Date = new Date()): Promise<SkillUsageRecord> {
  return updateRecord(projectDir, name, now, (record, iso) => {
    if (success) {
      record.successCount = (record.successCount ?? 0) + 1;
      record.consecutiveFailures = 0;
      if (record.status === 'probation' && record.successCount >= PROBATION_SUCCESSES) record.status = 'proven';
    } else {
      record.failureCount = (record.failureCount ?? 0) + 1;
      record.consecutiveFailures = (record.consecutiveFailures ?? 0) + 1;
    }
    record.lastOutcomeAt = iso;
    record.updatedAt = iso;
  });
}

/**
 * The agent wrote a new version of a skill: it starts on probation with a
 * clean slate, so a rewrite has to prove itself again.
 */
export async function recordAgentSkillRevision(projectDir: string, name: string, options: { replacedExisting: boolean }, now: Date = new Date()): Promise<SkillUsageRecord> {
  return updateRecord(projectDir, name, now, (record, iso) => {
    record.version = (record.version ?? (options.replacedExisting ? 1 : 0)) + 1;
    record.status = 'probation';
    record.successCount = 0;
    record.consecutiveFailures = 0;
    record.updatedAt = iso;
  });
}

/** Short label for a skill's standing, or '' for an established skill. */
export function skillStandingLabel(record: SkillUsageRecord | undefined): string {
  if (!record) return '';
  const failing = record.consecutiveFailures ?? 0;
  if (failing >= 2) return `failing: the last ${failing} runs that used it did not finish cleanly`;
  if (record.status === 'probation') return `new, unproven: ${record.successCount ?? 0}/${PROBATION_SUCCESSES} clean runs`;
  return '';
}

export async function setSkillPinned(projectDir: string, name: string, pinned: boolean, now: Date = new Date()): Promise<SkillUsageRecord> {
  return updateRecord(projectDir, name, now, (record, iso) => {
    record.pinned = pinned;
    record.updatedAt = iso;
  });
}

export async function setSkillArchived(projectDir: string, name: string, archived: boolean, now: Date = new Date()): Promise<SkillUsageRecord> {
  return updateRecord(projectDir, name, now, (record, iso) => {
    record.archived = archived;
    record.updatedAt = iso;
  });
}

export async function listSkillUsage(projectDir: string): Promise<SkillUsageRecord[]> {
  const store = await loadSkillUsage(projectDir);
  return Object.values(store.records);
}

export async function getSkillUsage(projectDir: string, name: string): Promise<SkillUsageRecord | undefined> {
  const store = await loadSkillUsage(projectDir);
  return store.records[name];
}
