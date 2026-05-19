import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream } from 'fs';
import type { EvidenceCard } from '../types/evidence';
import { recordSwallowed } from '../observability/silentFailureSink';

export interface StoredRunEvidence extends EvidenceCard {
  runId?: string;
  runName?: string;
}

const MAX_STORED_RUN_EVIDENCE = 1_000;
const knownRunEvidenceCounts = new Map<string, number>();

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
  await fs.appendFile(filePath, JSON.stringify(evidence) + '\n', 'utf-8');
  await pruneRunEvidence(projectDir, MAX_STORED_RUN_EVIDENCE).catch((err) => recordSwallowed('evidenceStore.prune', err));
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
  const filePath = runEvidencePath(projectDir);
  try {
    await fs.access(filePath);
  } catch {
    return [];
  }
  // Stream the file line-by-line so large JSONL files do not load entirely
  // into memory. We keep the last `limit` entries in a ring buffer.
  const entries: StoredRunEvidence[] = [];
  const rl = readline.createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as StoredRunEvidence);
      if (entries.length > limit * 2) {
        // Periodically trim to avoid unbounded growth during read.
        entries.splice(0, entries.length - limit);
      }
    } catch { /* skip corrupt lines */ }
  }
  return entries.slice(-limit).reverse();
}

function runEvidencePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'evidence', 'runs.jsonl');
}

async function pruneRunEvidence(projectDir: string, maxEntries: number): Promise<void> {
  const filePath = runEvidencePath(projectDir);
  const knownCount = knownRunEvidenceCounts.get(filePath);
  const count = knownCount === undefined ? await countRunEvidenceLines(filePath) : knownCount + 1;
  knownRunEvidenceCounts.set(filePath, count);
  if (count <= maxEntries) return;
  const entries = await readRunEvidence(projectDir, maxEntries);
  if (entries.length < maxEntries) return;
  await fs.writeFile(filePath, entries.reverse().map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
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
