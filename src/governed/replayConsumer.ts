// Governed Agent Loop — replay consumer.
//
// The consumer side of the durable .harness/needs-review-replay.jsonl seam that
// the review queue appends to when a human drains a needs-review answer. It
// parses the staged candidates and can atomically clear them once consumed, so
// a downstream auto-research / replay process handles each drained answer
// exactly once. It runs NO research loop itself — it hands the parsed
// candidates to whoever calls it.
//
// Mirrors the harness persistence convention: async fs, file-locked truncate,
// failures logged not thrown (a missing seam simply means "nothing to replay").

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { logger } from '../core/logger';

export interface ReplayCandidate {
  id: string;
  content: string;
  reason: string;
  drainedAt: string;
}

let replayLogPath: string | null = null;

export function initReplayConsumer(projectDir: string): void {
  replayLogPath = path.join(projectDir, '.harness', 'needs-review-replay.jsonl');
}

function parseLines(raw: string): ReplayCandidate[] {
  const out: ReplayCandidate[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.id === 'string') {
        out.push({
          id: parsed.id,
          content: typeof parsed.content === 'string' ? parsed.content : '',
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
          drainedAt: typeof parsed.drainedAt === 'string' ? parsed.drainedAt : '',
        });
      }
    } catch (err) {
      logger.warn('ReplayConsumer', 'Skipped malformed replay line', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Read all pending replay candidates without consuming them. */
export async function readReplayCandidates(): Promise<ReplayCandidate[]> {
  if (!replayLogPath) return [];
  try {
    const raw = await fs.promises.readFile(replayLogPath, 'utf-8');
    return parseLines(raw);
  } catch {
    return []; // missing seam = nothing to replay
  }
}

/** Read and atomically clear the seam so each candidate is consumed exactly once. */
export async function consumeReplayCandidates(): Promise<ReplayCandidate[]> {
  if (!replayLogPath) return [];
  const target = replayLogPath;
  return withFileLock(target, async () => {
    let raw: string;
    try {
      raw = await fs.promises.readFile(target, 'utf-8');
    } catch {
      return [];
    }
    const candidates = parseLines(raw);
    if (candidates.length > 0) {
      await atomicWriteFile(target, '', { encoding: 'utf-8', mode: 0o600 });
    }
    return candidates;
  });
}
