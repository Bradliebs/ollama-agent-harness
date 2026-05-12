// Permission outcome → trust-ladder feedback.
//
// Whenever the user resolves a permission prompt (or the engine grants/denies
// one automatically), the outcome flows here so the trust ladder learns
// without the user having to click promote/demote in the UI.
//
// Capability mapping is intentionally narrow: we use the tool name as the
// capability key. Callers may pass an explicit override.

import { ensureCapability, loadTrustLadder, recordOutcome, saveTrustLadder } from './trustLadder';

export type PermissionOutcomeKind = 'allowed' | 'denied';

export interface RecordPermissionOutcomeOptions {
  /** Override the capability key derived from the tool name. */
  capability?: string;
  /** Skip recording when no real action was taken (e.g. dry-run). */
  skip?: boolean;
}

export async function recordPermissionOutcome(
  projectDir: string,
  toolName: string,
  outcome: PermissionOutcomeKind,
  options: RecordPermissionOutcomeOptions = {},
): Promise<void> {
  if (options.skip) return;
  const capability = options.capability ?? toolName;
  if (!capability) return;
  const snap = await loadTrustLadder(projectDir);
  ensureCapability(snap, capability);
  recordOutcome(snap, capability, outcome === 'allowed' ? 'accepted' : 'rejected');
  await saveTrustLadder(projectDir, snap);
}
