import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream } from 'fs';
import type { EvidenceCard } from '../types/evidence';
import { recordSwallowed } from '../observability/silentFailureSink';
import { atomicWriteFile, withFileLock } from './atomicFile';

export interface StoredRunEvidence extends EvidenceCard {
  runId?: string;
  runName?: string;
}

const MAX_STORED_RUN_EVIDENCE = 1_000;
const knownRunEvidenceCounts = new Map<string, number>();

export interface RunEvidenceDiagnostics {
  path: string;
  missing: boolean;
  totalLines: number;
  validEntries: number;
  corruptLines: number;
  unreadable: boolean;
  error?: string;
}

export interface RunEvidenceReadResult {
  entries: StoredRunEvidence[];
  diagnostics: RunEvidenceDiagnostics;
}

export interface RunEvidenceHealth {
  status: 'healthy' | 'warning' | 'missing' | 'error';
  path: string;
  totalLines: number;
  validEntries: number;
  corruptLines: number;
  unreadable: boolean;
  error?: string;
}

/**
 * Optional hooks invoked after each successful append. Used by the jarvis
 * layer to mirror evidence cards into the knowledge graph. Hooks are
 * fire-and-forget and isolated; an exception in one never blocks the append
 * or other hooks.
 */
export type EvidenceAppendHook = (projectDir: string, evidence: StoredRunEvidence) => void | Promise<void>;
const evidenceAppendHooks: EvidenceAppendHook[] = [];

export function setEvidenceAppendHook(hook: EvidenceAppendHook): void {
  evidenceAppendHooks.push(hook);
}

export function clearEvidenceAppendHooks(): void {
  evidenceAppendHooks.length = 0;
}

export async function appendRunEvidence(projectDir: string, evidence: StoredRunEvidence): Promise<string> {
  const filePath = runEvidencePath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await withFileLock(filePath, async () => {
    await fs.appendFile(filePath, JSON.stringify(evidence) + '\n', 'utf-8');
    await pruneRunEvidenceUnlocked(projectDir, MAX_STORED_RUN_EVIDENCE).catch((err) => recordSwallowed('evidenceStore.prune', err));
  });
  for (const hook of evidenceAppendHooks) {
    try {
      await hook(projectDir, evidence);
    } catch (err) {
      recordSwallowed('evidenceStore.appendHook', err);
    }
  }
  return filePath;
}

export async function readRunEvidence(projectDir: string, limit = 100): Promise<StoredRunEvidence[]> {
  const result = await readRunEvidenceDetailed(projectDir, limit);
  return result.entries;
}

export async function readRunEvidenceDetailed(projectDir: string, limit = 100): Promise<RunEvidenceReadResult> {
  const filePath = runEvidencePath(projectDir);
  const diagnostics: RunEvidenceDiagnostics = {
    path: filePath,
    missing: false,
    totalLines: 0,
    validEntries: 0,
    corruptLines: 0,
    unreadable: false,
  };
  try {
    await fs.access(filePath);
  } catch {
    diagnostics.missing = true;
    return { entries: [], diagnostics };
  }
  // Stream the file line-by-line so large JSONL files do not load entirely
  // into memory. We keep the last `limit` entries in a ring buffer.
  const entries: StoredRunEvidence[] = [];
  try {
    const rl = readline.createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      diagnostics.totalLines += 1;
      try {
        entries.push(JSON.parse(line) as StoredRunEvidence);
        diagnostics.validEntries += 1;
        if (entries.length > limit * 2) {
          // Periodically trim to avoid unbounded growth during read.
          entries.splice(0, entries.length - limit);
        }
      } catch {
        diagnostics.corruptLines += 1;
      }
    }
  } catch (error) {
    diagnostics.unreadable = true;
    diagnostics.error = error instanceof Error ? error.message : String(error);
    return { entries: [], diagnostics };
  }
  return { entries: entries.slice(-limit).reverse(), diagnostics };
}

export async function inspectRunEvidence(projectDir: string): Promise<RunEvidenceHealth> {
  const result = await readRunEvidenceDetailed(projectDir, MAX_STORED_RUN_EVIDENCE);
  const diagnostics = result.diagnostics;
  const status = diagnostics.unreadable
    ? 'error'
    : diagnostics.missing
      ? 'missing'
      : diagnostics.corruptLines > 0
        ? 'warning'
        : 'healthy';
  return {
    status,
    path: diagnostics.path,
    totalLines: diagnostics.totalLines,
    validEntries: diagnostics.validEntries,
    corruptLines: diagnostics.corruptLines,
    unreadable: diagnostics.unreadable,
    ...(diagnostics.error ? { error: diagnostics.error } : {}),
  };
}

function runEvidencePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'evidence', 'runs.jsonl');
}

async function pruneRunEvidence(projectDir: string, maxEntries: number): Promise<void> {
  const filePath = runEvidencePath(projectDir);
  await withFileLock(filePath, async () => pruneRunEvidenceUnlocked(projectDir, maxEntries));
}

async function pruneRunEvidenceUnlocked(projectDir: string, maxEntries: number): Promise<void> {
  const filePath = runEvidencePath(projectDir);
  const knownCount = knownRunEvidenceCounts.get(filePath);
  const count = knownCount === undefined ? await countRunEvidenceLines(filePath) : knownCount + 1;
  knownRunEvidenceCounts.set(filePath, count);
  if (count <= maxEntries) return;
  const entries = await readRunEvidence(projectDir, maxEntries);
  if (entries.length < maxEntries) return;
  await atomicWriteFile(filePath, entries.reverse().map((entry) => JSON.stringify(entry)).join('\n') + '\n', { encoding: 'utf-8' });
  knownRunEvidenceCounts.set(filePath, maxEntries);
}

async function countRunEvidenceLines(filePath: string): Promise<number> {
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (line.trim()) count++;
  }
  return count;
}
