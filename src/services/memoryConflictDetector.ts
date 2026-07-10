// Memory conflict and staleness detector.
//
// Provides two independent analyses over the existing markdown memory files:
//
//   detectConflicts(existing, newBody)
//     — compares a candidate new entry against existing sections in the same
//       file and flags topically-related pairs where the new text appears to
//       contradict or supersede the old text (or vice versa).
//
//   detectStaleness(section, opts?)
//     — classifies a single section by age into fresh / aging / stale /
//       very_stale tiers.
//
//   scanFileForConflicts(projectDir, fileName, newBody)
//     — high-level: reads a memory file from disk and returns all conflicts
//       between the candidate body and every existing section.
//
//   findStaleEntries(projectDir, fileName, opts?)
//     — reads a memory file and returns all sections older than the threshold.
//
// Deterministic — no model calls required.

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseMemoryFile, type MemorySection } from './memoryIntelligence';
export type { MemorySection } from './memoryIntelligence';

// ─── Types ──────────────────────────────────────────────────────────

export type ConflictType =
  | 'negation'      // new text negates a claim in the old text
  | 'supersession'  // new text says the old approach is outdated/removed
  | 'contradiction' // shared topic, opposing polarity on a key term
  | 'duplicate';    // essentially identical (high token overlap)

export type StalenessLevel = 'fresh' | 'aging' | 'stale' | 'very_stale' | 'unknown';

export interface ConflictResult {
  /** The existing section that the candidate conflicts with. */
  existingSection: MemorySection;
  /** Human-readable explanation of why this is flagged as a conflict. */
  reason: string;
  /** Category of conflict. */
  conflictType: ConflictType;
  /**
   * 0.0–1.0 confidence that this is a genuine conflict.
   * Values below 0.4 are indicative only.
   */
  confidence: number;
  /**
   * Shared topic words that linked the two entries together.
   * Empty for `duplicate` conflicts.
   */
  sharedTopics: string[];
}

export interface StalenessResult {
  section: MemorySection;
  level: StalenessLevel;
  /** Age in milliseconds; 0 when `createdAt` is absent. */
  ageMs: number;
  /** ISO date string from the section metadata, or undefined. */
  createdAt: string | undefined;
}

export interface StalenessThresholds {
  /** < this → fresh (default: 7 days). */
  agingMs?: number;
  /** < this → aging (default: 30 days). */
  staleMs?: number;
  /** < this → stale (default: 90 days). */
  veryStaleMs?: number;
}

const DEFAULT_THRESHOLDS: Required<StalenessThresholds> = {
  agingMs: 7 * 24 * 60 * 60 * 1000,
  staleMs: 30 * 24 * 60 * 60 * 1000,
  veryStaleMs: 90 * 24 * 60 * 60 * 1000,
};

// ─── Negation vocabulary ─────────────────────────────────────────────

/** Tokens that reverse the meaning of a nearby claim. */
const NEGATION_TOKENS = new Set([
  'not', 'never', 'avoid', 'avoids', 'avoided',
  'no', "don't", 'dont', 'do not', 'does not', 'doesn\'t', 'doesnt',
  'removed', 'deprecated', 'obsolete', 'replaced', 'stop',
  'should not', 'must not', 'cannot', 'can\'t', 'cant',
  'instead', 'rather', 'wrong', 'incorrect', 'bad',
  'broken', 'retire', 'retired', 'disallow', 'forbidden', 'banned',
  'no longer', 'unnecessary',
]);

/** Tokens that signal the old approach is superseded. */
const SUPERSESSION_TOKENS = new Set([
  'deprecated', 'obsolete', 'removed', 'replaced', 'superseded',
  'outdated', 'old way', 'legacy', 'no longer', 'retire', 'retired',
  'migration', 'migrate', 'upgrade',
]);

/** English stopwords to exclude from topic extraction. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'that', 'this', 'it', 'its', 'all',
  'which', 'when', 'where', 'if', 'so', 'as', 'up', 'out', 'into', 'we',
  'our', 'us', 'my', 'i', 'you', 'your', 'he', 'she', 'they', 'them',
  'then', 'than', 'use', 'used', 'using', 'also', 'just', 'what', 'how',
  'any', 'some', 'more', 'now', 'new', 'old', 'each', 'only', 'make',
  'good', 'well', 'very', 'here', 'there', 'after', 'before', 'about',
  'like', 'always', 'add', 'get', 'set', 'see', 'run', 'create',
]);

// ─── Core analysis ───────────────────────────────────────────────────

/**
 * Compare a candidate `newBody` against a list of existing sections.
 * Returns one `ConflictResult` for each section that appears to conflict.
 */
export function detectConflicts(
  existingSections: MemorySection[],
  newBody: string,
): ConflictResult[] {
  const newTokens = extractContentWords(newBody);
  const newNegated = extractNegatedWords(newBody);
  const newHasSupersession = containsAnyToken(newBody, SUPERSESSION_TOKENS);
  const results: ConflictResult[] = [];

  for (const section of existingSections) {
    const oldTokens = extractContentWords(section.body + ' ' + section.title);
    const sharedTopics = intersection(newTokens, oldTokens);

    // Need at least 2 shared topic words for a topical link.
    if (sharedTopics.length < 2) continue;

    // ── Duplicate check ─────────────────────────────────────────────
    // High token overlap (≥ 70 %) → treat as near-duplicate.
    const tokenOverlap = sharedTopics.length / Math.min(newTokens.size, oldTokens.size);
    if (tokenOverlap >= 0.70) {
      results.push({
        existingSection: section,
        reason: `New entry is nearly identical to existing section "${section.title}" (${Math.round(tokenOverlap * 100)}% token overlap).`,
        conflictType: 'duplicate',
        confidence: Math.min(0.95, tokenOverlap),
        sharedTopics: [],
      });
      continue;
    }

    // ── Supersession check ──────────────────────────────────────────
    // New text flags something as deprecated/replaced that the old section affirms.
    // Check: does the new body contain a supersession marker AND share topic words
    // with the old section? If so the old section is likely being superseded.
    if (newHasSupersession) {
      // Find topic words that appear in both, which are positively affirmed in the old section
      const oldContentWords = extractContentWords(section.body);
      const supersededTopics = intersection(newNegated, oldContentWords);
      // Also flag when the new text simply shares topic words AND has a supersession marker
      // (the deprecated/replaced concept may refer to the shared topic even if the
      // negated words don't overlap perfectly)
      const sharedWithOld = intersection(newTokens, oldContentWords);
      if (supersededTopics.length >= 1) {
        results.push({
          existingSection: section,
          reason: `New entry marks "${supersededTopics.slice(0, 3).join(', ')}" as deprecated/removed; existing section "${section.title}" affirms the same approach.`,
          conflictType: 'supersession',
          confidence: Math.min(0.9, 0.5 + supersededTopics.length * 0.15),
          sharedTopics,
        });
        continue;
      } else if (sharedWithOld.length >= 2) {
        // Broader: the new text mentions this topic in a supersession context
        results.push({
          existingSection: section,
          reason: `New entry supersedes the approach in "${section.title}" (shared topic: ${sharedWithOld.slice(0, 3).join(', ')}).`,
          conflictType: 'supersession',
          confidence: Math.min(0.75, 0.35 + sharedWithOld.length * 0.10),
          sharedTopics,
        });
        continue;
      }
    }

    // ── Negation check ──────────────────────────────────────────────
    // New text negates words that the old section used positively, or vice versa.
    const oldNegated = extractNegatedWords(section.body);
    const newNegatesOld = intersection(newNegated, extractContentWords(section.body));
    const oldNegatesNew = intersection(oldNegated, newTokens);

    if (newNegatesOld.length >= 1) {
      results.push({
        existingSection: section,
        reason: `New entry negates "${newNegatesOld.slice(0, 3).join(', ')}" which is affirmed in existing section "${section.title}".`,
        conflictType: 'negation',
        confidence: Math.min(0.85, 0.45 + newNegatesOld.length * 0.15),
        sharedTopics,
      });
    } else if (oldNegatesNew.length >= 1) {
      results.push({
        existingSection: section,
        reason: `Existing section "${section.title}" negates "${oldNegatesNew.slice(0, 3).join(', ')}" which the new entry affirms.`,
        conflictType: 'contradiction',
        confidence: Math.min(0.80, 0.40 + oldNegatesNew.length * 0.15),
        sharedTopics,
      });
    }
  }

  return results;
}

/**
 * Classify a single section by age.
 * When `createdAt` is absent the level is `'unknown'`.
 */
export function detectStaleness(
  section: MemorySection,
  opts: StalenessThresholds = {},
  now = Date.now(),
): StalenessResult {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...opts };

  if (!section.createdAt) {
    return { section, level: 'unknown', ageMs: 0, createdAt: undefined };
  }

  const createdMs = Date.parse(section.createdAt);
  if (!Number.isFinite(createdMs)) {
    return { section, level: 'unknown', ageMs: 0, createdAt: section.createdAt };
  }

  const ageMs = now - createdMs;
  let level: StalenessLevel;

  if (ageMs < thresholds.agingMs) {
    level = 'fresh';
  } else if (ageMs < thresholds.staleMs) {
    level = 'aging';
  } else if (ageMs < thresholds.veryStaleMs) {
    level = 'stale';
  } else {
    level = 'very_stale';
  }

  return { section, level, ageMs, createdAt: section.createdAt };
}

// ─── File-level helpers ──────────────────────────────────────────────

/**
 * Read `<projectDir>/.harness/memory/<fileName>` and return every conflict
 * between `newBody` and existing sections.
 */
export async function scanFileForConflicts(
  projectDir: string,
  fileName: string,
  newBody: string,
): Promise<ConflictResult[]> {
  const filePath = path.join(projectDir, '.harness', 'memory', fileName);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const file = parseMemoryFile(content, filePath);
  return detectConflicts(file.sections, newBody);
}

/**
 * Default confidence at or above which a conflict is treated as blocking when
 * enforce mode is on. Chosen so only high-confidence conflicts block: exact
 * duplicates (≥0.80 token overlap), strong supersessions, and strong negations.
 */
export const DEFAULT_CONFLICT_BLOCK_THRESHOLD = 0.8;

/**
 * Pure policy helper: select the conflicts whose confidence meets `threshold`.
 * Used by enforce mode to decide which conflicts should block a memory write.
 */
export function selectBlockingConflicts(
  conflicts: ConflictResult[],
  threshold: number = DEFAULT_CONFLICT_BLOCK_THRESHOLD,
): ConflictResult[] {
  return conflicts.filter((c) => c.confidence >= threshold);
}

/**
 * Read `<projectDir>/.harness/memory/<fileName>` and return all sections
 * whose `createdAt` puts them in the `stale` or `very_stale` tier.
 */
export async function findStaleEntries(
  projectDir: string,
  fileName: string,
  opts: StalenessThresholds = {},
): Promise<StalenessResult[]> {
  const filePath = path.join(projectDir, '.harness', 'memory', fileName);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const file = parseMemoryFile(content, filePath);
  return file.sections
    .map((section) => detectStaleness(section, opts))
    .filter((r) => r.level === 'stale' || r.level === 'very_stale');
}

/**
 * Scan all markdown files in the memory directory and return stale entries
 * grouped by file name.
 */
export async function findAllStaleEntries(
  projectDir: string,
  opts: StalenessThresholds = {},
): Promise<Record<string, StalenessResult[]>> {
  const dir = path.join(projectDir, '.harness', 'memory');
  let entries: import('fs').Dirent[];
  try {
    const { readdir } = await import('fs/promises');
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return {};
  }
  const result: Record<string, StalenessResult[]> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const stale = await findStaleEntries(projectDir, entry.name, opts);
    if (stale.length > 0) result[entry.name] = stale;
  }
  return result;
}

// ─── Token utilities ─────────────────────────────────────────────────

/** Extract meaningful content words from text (min 4 chars, non-stopword). */
export function extractContentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
  );
}

/**
 * Extract words that appear near a negation token in the text.
 * Returns the content words that are semantically negated.
 */
export function extractNegatedWords(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = lower.replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/);
  const negated = new Set<string>();

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const bigramForward = i + 1 < words.length ? `${w} ${words[i + 1]}` : '';

    if (NEGATION_TOKENS.has(w) || NEGATION_TOKENS.has(bigramForward)) {
      // Collect content words in the 3-word window after the negation.
      for (let j = i + 1; j <= Math.min(i + 4, words.length - 1); j++) {
        const target = words[j];
        if (target.length >= 4 && !STOPWORDS.has(target)) {
          negated.add(target);
        }
      }
    }
  }
  return negated;
}

function intersection(a: Set<string>, b: Set<string>): string[] {
  const result: string[] = [];
  for (const item of a) if (b.has(item)) result.push(item);
  return result;
}

function containsAnyToken(text: string, tokens: Set<string>): boolean {
  const lower = text.toLowerCase();
  for (const token of tokens) {
    if (lower.includes(token)) return true;
  }
  return false;
}
