// Governed Agent Loop — per-answer self-critique pass.
//
// Before an answer is trusted, run the four questions a careful reviewer asks:
// is this cited? is it old? is it fact or judgement? what would make this wrong?
// Pure function over signals the harness already has (confidence mode, citation
// count, source age, assumptions, conflict). Produces structured findings and an
// overall verdict; it never blocks or mutates — it surfaces, the caller decides.

import type { ConfidenceMode } from './confidenceMode';

export type SelfCritiqueStatus = 'ok' | 'warn' | 'flag';

export interface SelfCritiqueFinding {
  check: string;
  status: SelfCritiqueStatus;
  detail: string;
}

export interface SelfCritiqueInput {
  confidenceMode: ConfidenceMode;
  /** Total citations backing the answer (brain + web). */
  citations?: number;
  /** Age of the oldest relied-on source in ms; undefined = no dated source. */
  oldestSourceAgeMs?: number;
  /** Assumptions the answer rests on. */
  assumptions?: string[];
  /** Sources disagreed with each other. */
  conflict?: boolean;
}

export interface SelfCritiqueResult {
  findings: SelfCritiqueFinding[];
  overall: 'ok' | 'review';
}

// ~6 months: a source older than this for a time-sensitive answer is worth a
// freshness warning.
export const DEFAULT_STALE_SOURCE_MS = 180 * 24 * 60 * 60 * 1000;

export function selfCritique(
  input: SelfCritiqueInput,
  staleThresholdMs: number = DEFAULT_STALE_SOURCE_MS,
): SelfCritiqueResult {
  const { confidenceMode, citations = 0, oldestSourceAgeMs, assumptions = [], conflict = false } = input;
  const findings: SelfCritiqueFinding[] = [];

  // Is this cited?
  findings.push(citations > 0
    ? { check: 'cited', status: 'ok', detail: `${citations} citation(s)` }
    : { check: 'cited', status: confidenceMode === 'inferred' ? 'warn' : 'flag', detail: 'no citations backing this answer' });

  // Is this old?
  if (oldestSourceAgeMs !== undefined && oldestSourceAgeMs > staleThresholdMs) {
    findings.push({ check: 'fresh', status: 'warn', detail: `oldest source is ${Math.round(oldestSourceAgeMs / 86_400_000)} days old` });
  } else {
    findings.push({ check: 'fresh', status: 'ok', detail: 'sources within freshness window' });
  }

  // Fact vs judgement?
  findings.push(confidenceMode === 'from-brain'
    ? { check: 'fact-vs-judgement', status: 'ok', detail: 'grounded in stored knowledge' }
    : { check: 'fact-vs-judgement', status: confidenceMode === 'needs-review' ? 'flag' : 'warn', detail: `mode is ${confidenceMode}` });

  // What would make this wrong?
  if (conflict) {
    findings.push({ check: 'what-would-make-this-wrong', status: 'flag', detail: 'sources conflicted; one side is wrong' });
  } else if (assumptions.length > 0) {
    findings.push({ check: 'what-would-make-this-wrong', status: 'warn', detail: `rests on ${assumptions.length} assumption(s)` });
  } else {
    findings.push({ check: 'what-would-make-this-wrong', status: 'ok', detail: 'no unstated assumptions surfaced' });
  }

  const overall = findings.some((f) => f.status === 'flag') ? 'review' : 'ok';
  return { findings, overall };
}
