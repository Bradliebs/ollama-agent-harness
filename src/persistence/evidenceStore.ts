import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream } from 'fs';
import type { EvidenceCard } from '../types/evidence';

export interface StoredRunEvidence extends EvidenceCard {
  runId?: string;
  runName?: string;
}

export async function appendRunEvidence(projectDir: string, evidence: StoredRunEvidence): Promise<string> {
  const filePath = runEvidencePath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(evidence) + '\n', 'utf-8');
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
