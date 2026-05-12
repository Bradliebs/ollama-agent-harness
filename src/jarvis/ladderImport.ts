// Trust-ladder import/merge.
//
// Two strategies:
//   max-rung-wins (default) — for each capability, keep the higher of the
//     two rungs. Streaks are reset (the new rung is the source of truth).
//   last-wins — incoming wins for every capability present in `incoming`.
//
// Streaks intentionally reset on import: imported state is a snapshot, not
// a stream of outcomes. If you want to preserve streaks, use `last-wins`
// AND export+import via the same exporter.

import type { CapabilityTrust, TrustLadderSnapshot, TrustRung } from './trustLadder';

export type LadderMergeStrategy = 'max-rung-wins' | 'last-wins';

export interface MergeStats {
  totalCapabilities: number;
  promoted: string[];
  demoted: string[];
  unchanged: string[];
  added: string[];
}

export function mergeLadders(local: TrustLadderSnapshot, incoming: TrustLadderSnapshot, strategy: LadderMergeStrategy = 'max-rung-wins'): { merged: TrustLadderSnapshot; stats: MergeStats } {
  const merged: TrustLadderSnapshot = { capabilities: { ...local.capabilities }, updatedAt: new Date().toISOString() };
  const promoted: string[] = [];
  const demoted: string[] = [];
  const unchanged: string[] = [];
  const added: string[] = [];

  for (const [key, incomingEntry] of Object.entries(incoming.capabilities)) {
    const localEntry = merged.capabilities[key];
    if (!localEntry) {
      merged.capabilities[key] = { ...incomingEntry, acceptedStreak: 0, rejectedStreak: 0 };
      added.push(key);
      continue;
    }
    const localRung = localEntry.rung;
    const newRung: TrustRung = strategy === 'max-rung-wins'
      ? (Math.max(localRung, incomingEntry.rung) as TrustRung)
      : incomingEntry.rung;
    if (newRung > localRung) {
      merged.capabilities[key] = makeEntry(key, newRung, incomingEntry, localEntry);
      promoted.push(key);
    } else if (newRung < localRung) {
      merged.capabilities[key] = makeEntry(key, newRung, incomingEntry, localEntry);
      demoted.push(key);
    } else {
      unchanged.push(key);
    }
  }

  return {
    merged,
    stats: {
      totalCapabilities: Object.keys(merged.capabilities).length,
      promoted,
      demoted,
      unchanged,
      added,
    },
  };
}

function makeEntry(capability: string, rung: TrustRung, incoming: CapabilityTrust, local: CapabilityTrust): CapabilityTrust {
  return {
    capability,
    rung,
    acceptedStreak: 0,
    rejectedStreak: 0,
    decayAfterMs: incoming.decayAfterMs ?? local.decayAfterMs,
    lastUsedAt: new Date().toISOString(),
  };
}
