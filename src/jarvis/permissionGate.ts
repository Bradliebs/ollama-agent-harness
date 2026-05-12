// Trust ladder permission gate — pure overlay over PermissionEngine.
//
// Rather than mutating the existing PermissionEngine (which is load-bearing),
// callers consult `evaluatePermissionGate` BEFORE handing off to the engine.
// The gate translates the trust rung into one of four high-level decisions:
//
//   shadow   — never execute; log only as proposed action
//   suggest  — surface a Mission Control card; user clicks to execute
//   confirm  — require typed confirmation token (kill-switch style)
//   allow    — let the underlying PermissionEngine make the final call
//
// The web server and autonomy loop can opt into the gate by wrapping the
// permission check. Existing callers keep working unchanged.

import { canActAutonomously, getRung, requiresConfirmation, type TrustLadderSnapshot, type TrustRung } from './trustLadder';

export type GateDecision = 'shadow' | 'suggest' | 'confirm' | 'allow';

export interface GateInput {
  /** Capability key. Should match the entry in the trust ladder. */
  capability: string;
  /** Tool/action label for the surfaced card. */
  label?: string;
}

export interface GateResult {
  decision: GateDecision;
  rung: TrustRung;
  rationale: string;
}

export function evaluatePermissionGate(snap: TrustLadderSnapshot, input: GateInput): GateResult {
  const rung = getRung(snap, input.capability);
  if (rung === 0) return { decision: 'shadow', rung, rationale: 'Capability is at rung 0 (shadow) — observe only.' };
  if (rung === 1) return { decision: 'suggest', rung, rationale: 'Capability is at rung 1 (suggest) — surface a card, do not execute.' };
  if (rung === 2) return { decision: 'allow', rung, rationale: 'Capability is at rung 2 (ask) — defer to PermissionEngine for the standard prompt.' };
  if (requiresConfirmation(snap, input.capability)) return { decision: 'confirm', rung, rationale: 'Capability is at rung 3 (confirm) — typed confirmation required.' };
  if (canActAutonomously(snap, input.capability)) return { decision: 'allow', rung, rationale: 'Capability is at rung 4 (act) — autonomous execution permitted.' };
  return { decision: 'allow', rung, rationale: 'Default: defer to PermissionEngine.' };
}

/** Convenience: resolve "should I even bother asking PermissionEngine?" */
export function shouldDeferToEngine(result: GateResult): boolean {
  return result.decision === 'allow' || result.decision === 'confirm';
}
