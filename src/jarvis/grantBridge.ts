// Capability grant ↔ trust ladder bridge.
//
// When the user creates a capability grant, it's a strong signal of trust:
// promote the matching ladder rung once. When the user revokes a grant, it's
// a strong signal of distrust: demote the rung.
//
// Mapping is direct (capability id === ladder capability key) so callers
// don't need to translate.

import { ensureCapability, recordOutcome, type TrustLadderSnapshot } from './trustLadder';

export type GrantAction = 'create' | 'revoke';

export interface BridgeResult {
  capability: string;
  rung: number;
  promoted?: number;
  demoted?: number;
}

export function applyGrantToLadder(snap: TrustLadderSnapshot, capability: string, action: GrantAction): BridgeResult {
  ensureCapability(snap, capability);
  // One grant action = one outcome; the ladder thresholds (5 for promote,
  // 2 for demote) determine when an actual rung change occurs.
  const outcome = action === 'create' ? 'accepted' : 'rejected';
  const result = recordOutcome(snap, capability, outcome);
  return {
    capability,
    rung: snap.capabilities[capability].rung,
    promoted: result.promoted,
    demoted: result.demoted,
  };
}
