// Autonomy-prompt approval marker (lightweight, dependency-free).
//
// Phase 3 (src/experiments/autoGate.ts) writes this marker when an evolved
// prompt wins its guardrail-gated experiment. Phase 2 (the autonomy prompt
// path) reads it to decide whether to apply the evolved prompt to unattended
// builds. Both sides share these primitives so the autonomy hot path does NOT
// transitively import the experiment runner / benchmark stack.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Where the autonomy-prompt approval marker lives, relative to projectDir. */
export const APPROVAL_MARKER_RELPATH = path.join('.harness', 'learning', 'autonomy-prompt-approval.json');

/** Stable sha256 of a prompt string. Binds an approval to exact content. */
export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/** One entry written when a candidate prompt is promoted. */
export interface PromptApprovalMarker {
  /** sha256 of the approved candidate prompt. Re-hash before trusting. */
  approvedPromptHash: string;
  approvedAt: string;
  experimentId: string;
  passRateDelta: number;
  netCandidateWins: number;
  reasons: string[];
}

/** Read the approval marker, or null if absent/unreadable/malformed. */
export async function readApprovalMarker(projectDir: string): Promise<PromptApprovalMarker | null> {
  const markerPath = path.join(projectDir, APPROVAL_MARKER_RELPATH);
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as PromptApprovalMarker;
    if (typeof parsed.approvedPromptHash !== 'string' || parsed.approvedPromptHash.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the approval marker, creating parent directories as needed. */
export async function writeApprovalMarker(projectDir: string, marker: PromptApprovalMarker): Promise<void> {
  const markerPath = path.join(projectDir, APPROVAL_MARKER_RELPATH);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');
}
