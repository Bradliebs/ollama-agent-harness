// Trust Ladder — per-capability autonomy rungs.
//
// Maps each capability (file_write, bash, email_send, slack_send, ambient_act, etc.)
// to one of five rungs:
//
//   0 shadow    — observe only, never act, log proposed action
//   1 suggest   — propose an action in Mission Control, never execute
//   2 ask       — execute only after explicit user click
//   3 confirm   — execute after a typed confirmation token (kill-switch armed)
//   4 act       — execute autonomously, post-hoc evidence card
//
// Rungs decay back toward `ask` after a configurable idle window so a long
// quiet period re-arms the human-in-the-loop. Rungs escalate after a streak
// of accepted suggestions, never automatically — the user must accept the
// promotion via the existing learning-promotion gate.
//
// Storage is a single JSON file under `.harness/jarvis/trust-ladder.json` so
// it survives restarts but is trivially auditable / editable by the operator.

import * as fs from 'fs/promises';
import * as path from 'path';

export type TrustRung = 0 | 1 | 2 | 3 | 4;

export const RUNG_NAMES: Record<TrustRung, string> = {
  0: 'shadow',
  1: 'suggest',
  2: 'ask',
  3: 'confirm',
  4: 'act',
};

export interface CapabilityTrust {
  capability: string;
  rung: TrustRung;
  acceptedStreak: number;
  rejectedStreak: number;
  lastUsedAt?: string;
  decayAfterMs: number;
}

export interface TrustLadderSnapshot {
  capabilities: Record<string, CapabilityTrust>;
  updatedAt: string;
}

const DEFAULT_DECAY_MS = 1000 * 60 * 60 * 24 * 7; // one quiet week → re-arm
const PROMOTION_STREAK = 5;
const DEMOTION_STREAK = 2;

function ladderPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'jarvis', 'trust-ladder.json');
}

export async function loadTrustLadder(projectDir: string): Promise<TrustLadderSnapshot> {
  try {
    const raw = await fs.readFile(ladderPath(projectDir), 'utf8');
    return JSON.parse(raw) as TrustLadderSnapshot;
  } catch {
    return { capabilities: {}, updatedAt: new Date(0).toISOString() };
  }
}

export async function saveTrustLadder(projectDir: string, snap: TrustLadderSnapshot): Promise<void> {
  const filePath = ladderPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(snap, null, 2), 'utf8');
}

export function getRung(snap: TrustLadderSnapshot, capability: string): TrustRung {
  const entry = snap.capabilities[capability];
  if (!entry) return 2; // default: ask
  // Apply decay: if quiet for longer than decayAfterMs, drop one rung (floor 2)
  if (entry.lastUsedAt) {
    const elapsed = Date.now() - new Date(entry.lastUsedAt).getTime();
    if (elapsed > entry.decayAfterMs && entry.rung > 2) {
      return (entry.rung - 1) as TrustRung;
    }
  }
  return entry.rung;
}

export function ensureCapability(snap: TrustLadderSnapshot, capability: string): CapabilityTrust {
  let entry = snap.capabilities[capability];
  if (!entry) {
    entry = { capability, rung: 2, acceptedStreak: 0, rejectedStreak: 0, decayAfterMs: DEFAULT_DECAY_MS };
    snap.capabilities[capability] = entry;
  }
  return entry;
}

export function recordOutcome(
  snap: TrustLadderSnapshot,
  capability: string,
  outcome: 'accepted' | 'rejected' | 'used',
): { promoted?: TrustRung; demoted?: TrustRung } {
  const entry = ensureCapability(snap, capability);
  entry.lastUsedAt = new Date().toISOString();
  snap.updatedAt = entry.lastUsedAt;

  if (outcome === 'accepted') {
    entry.acceptedStreak += 1;
    entry.rejectedStreak = 0;
    if (entry.acceptedStreak >= PROMOTION_STREAK && entry.rung < 4) {
      entry.rung = (entry.rung + 1) as TrustRung;
      entry.acceptedStreak = 0;
      return { promoted: entry.rung };
    }
  } else if (outcome === 'rejected') {
    entry.rejectedStreak += 1;
    entry.acceptedStreak = 0;
    if (entry.rejectedStreak >= DEMOTION_STREAK && entry.rung > 0) {
      entry.rung = (entry.rung - 1) as TrustRung;
      entry.rejectedStreak = 0;
      return { demoted: entry.rung };
    }
  } else {
    // 'used' — neutral activity, just refreshes the decay timer
  }
  return {};
}

export function explainRung(rung: TrustRung): string {
  return `${rung} ${RUNG_NAMES[rung]}`;
}

/** Decide whether a proposed action may run autonomously right now. */
export function canActAutonomously(snap: TrustLadderSnapshot, capability: string): boolean {
  return getRung(snap, capability) === 4;
}

/** Decide whether a proposed action requires a typed confirmation token. */
export function requiresConfirmation(snap: TrustLadderSnapshot, capability: string): boolean {
  return getRung(snap, capability) === 3;
}
