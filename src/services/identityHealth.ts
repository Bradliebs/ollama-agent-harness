// Identity health check for the topbar persona badge.
//
// A test run once replaced the live SOUL.md with a one-line fixture and the
// assistant ran without its persona for weeks, because nothing on the main
// screen showed it. This summarises SOUL.md state so the UI can warn.

import * as fs from 'fs/promises';
import * as path from 'path';
import { readSoulProposal } from './identityProposals';

export type IdentityIssue = 'missing' | 'placeholder' | 'too-short';

export interface IdentityHealth {
  /** Persona name parsed from SOUL.md, or null when none is declared. */
  name: string | null;
  soulChars: number;
  issue: IdentityIssue | null;
  proposalPending: boolean;
  /** True when SOUL.md changed after the pending proposal was generated. */
  proposalStale: boolean;
  proposalCapturedAt: string | null;
}

/** Minimum length for a SOUL.md to count as a real persona. */
export const MIN_SOUL_CHARS = 200;

const PLACEHOLDER_MARKERS = [
  'Temporary import soul text for regression test.',
  'Long-term identity, voice, and values for the harness agent.',
];

export function parsePersonaName(soul: string): string | null {
  const heading = soul.match(/^#\s*Soul\s*[—–-]\s*(.+?)\s*$/m);
  if (heading) return heading[1].slice(0, 60);
  const iAm = soul.match(/\bI am \*\*([^*\n]{1,60})\*\*/);
  if (iAm) return iAm[1].trim();
  const myName = soul.match(/\bMy name is ([A-Z][\w'-]{0,40})/);
  return myName ? myName[1] : null;
}

export async function assessIdentityHealth(projectDir: string): Promise<IdentityHealth> {
  const soulPath = path.join(projectDir, '.harness', 'identity', 'SOUL.md');
  let soul = '';
  let soulMtimeMs: number | null = null;
  try {
    soul = await fs.readFile(soulPath, 'utf-8');
    soulMtimeMs = (await fs.stat(soulPath)).mtimeMs;
  } catch {
    soul = '';
  }
  const trimmed = soul.trim();
  let issue: IdentityIssue | null = null;
  if (soulMtimeMs === null || trimmed === '') issue = 'missing';
  else if (PLACEHOLDER_MARKERS.some((marker) => trimmed.includes(marker)) && trimmed.length < MIN_SOUL_CHARS * 2) issue = 'placeholder';
  else if (trimmed.length < MIN_SOUL_CHARS) issue = 'too-short';

  const proposal = await readSoulProposal(projectDir).catch(() => null);
  const capturedAtMs = proposal?.capturedAt ? Date.parse(proposal.capturedAt) : NaN;
  const proposalStale = Boolean(proposal) && soulMtimeMs !== null && Number.isFinite(capturedAtMs) && soulMtimeMs > capturedAtMs;

  return {
    name: issue ? null : parsePersonaName(soul),
    soulChars: trimmed.length,
    issue,
    proposalPending: Boolean(proposal),
    proposalStale,
    proposalCapturedAt: proposal?.capturedAt || null,
  };
}
