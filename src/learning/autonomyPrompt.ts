// Phase 2: carry learning into the AUTONOMY path — but only behind the Phase 3
// gate. The chat path already applies getEvolvedPrompt unconditionally because a
// human is in the loop. Autonomy runs unattended, so an evolved prompt is only
// applied when ALL of the following hold:
//   1. the master flag is on (default OFF — default behaviour is unchanged),
//   2. a Phase 3 approval marker exists, and
//   3. the approved hash still matches the CURRENT evolved prompt content
//      (so any drift in learned patterns/reflections invalidates the approval
//      and we fall back to the safe baseline).
//
// Contract for approval: the gate (gateEvolvedPrompt) must be run with
// candidatePrompt === getEvolvedPrompt(basePrompt). That exact string is what
// gets hashed into the marker, so this helper re-derives it and compares.

import { getEvolvedPrompt } from './engine';
import { hashPrompt, readApprovalMarker } from './promptApproval';

export type AutonomyPromptReason =
  | 'flag-off'
  | 'no-evolution'
  | 'not-approved'
  | 'approval-stale'
  | 'approved';

export interface AutonomyPromptOptions {
  projectDir: string;
  basePrompt: string;
  /** Master switch. Default OFF => always returns basePrompt unchanged. */
  applyEvolvedPrompt?: boolean;
  /** Injectable for tests. */
  getEvolvedPromptImpl?: (basePrompt: string) => Promise<string>;
  readApprovalMarkerImpl?: typeof readApprovalMarker;
}

export interface AutonomyPromptResult {
  prompt: string;
  applied: boolean;
  reason: AutonomyPromptReason;
}

export async function getApprovedAutonomyPrompt(opts: AutonomyPromptOptions): Promise<AutonomyPromptResult> {
  if (!opts.applyEvolvedPrompt) {
    return { prompt: opts.basePrompt, applied: false, reason: 'flag-off' };
  }

  const getEvolved = opts.getEvolvedPromptImpl ?? getEvolvedPrompt;
  const readMarker = opts.readApprovalMarkerImpl ?? readApprovalMarker;

  const evolved = await getEvolved(opts.basePrompt);
  if (evolved.trim() === opts.basePrompt.trim()) {
    return { prompt: opts.basePrompt, applied: false, reason: 'no-evolution' };
  }

  const marker = await readMarker(opts.projectDir);
  if (!marker) {
    return { prompt: opts.basePrompt, applied: false, reason: 'not-approved' };
  }
  if (marker.approvedPromptHash !== hashPrompt(evolved)) {
    return { prompt: opts.basePrompt, applied: false, reason: 'approval-stale' };
  }

  return { prompt: evolved, applied: true, reason: 'approved' };
}
