// Identity proposal layer (Phases 2 + 3 of adaptive identity).
//
// Two distinct mutation contracts:
//   - USER.md proposals can be auto-applied (Phase 2 — passive updates).
//   - SOUL.md proposals are always suggest-only — written to
//     SOUL.proposed.md for human review (Phase 3).
//
// Every mutation captures a snapshot via identityHistory BEFORE writing,
// so any change is reversible by id.

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  readIdentityFile,
  writeIdentityFile,
  type IdentityFileName,
} from './identity';
import { captureIdentitySnapshot } from './identityHistory';

export interface IdentityProposal {
  /** 'USER' | 'SOUL' — which file the proposal targets. */
  target: 'USER' | 'SOUL';
  /** Current on-disk content. */
  before: string;
  /** Proposed replacement content. */
  after: string;
  /** Model-provided rationale, or empty string if none parsed. */
  rationale: string;
}

export interface SoulProposalRecord extends IdentityProposal {
  target: 'SOUL';
  /** ISO timestamp when the proposal was written. */
  capturedAt: string;
}

/** Sentinel the model returns when no change is needed. */
const NO_CHANGE_SENTINEL = 'NO_CHANGE';

function soulProposalPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'identity', 'SOUL.proposed.md');
}

function buildProposalPrompt(
  target: 'USER' | 'SOUL',
  currentContent: string,
  observations: string,
): string {
  const fileName: IdentityFileName = target === 'USER' ? 'USER.md' : 'SOUL.md';
  const targetDescription =
    target === 'USER'
      ? 'long-term notes about the user (preferences, working style, recurring projects, context that helps the agent be useful)'
      : 'the agent\'s own long-term personality, voice, and values';
  return [
    `You are updating ${fileName}, which holds ${targetDescription}.`,
    '',
    `Current ${fileName}:`,
    '```markdown',
    currentContent.trim() || '(empty)',
    '```',
    '',
    'Recent observations from interaction:',
    '```',
    observations.trim() || '(none)',
    '```',
    '',
    'Decide whether the file should be updated. Be conservative: only',
    'propose a change if the observations reveal something durable that',
    'belongs in long-term memory. Cosmetic edits, restatements, or',
    'speculation are not enough.',
    '',
    'Respond in exactly one of two ways:',
    '',
    `1. If no change is warranted, respond with the single line: ${NO_CHANGE_SENTINEL}`,
    '',
    '2. If a change is warranted, respond with two fenced blocks:',
    '',
    '   ```identity',
    `   <complete new ${fileName} content here>`,
    '   ```',
    '',
    '   ```rationale',
    '   <one or two sentences explaining what changed and why>',
    '   ```',
    '',
    'The identity block must contain the FULL new file, not a diff.',
  ].join('\n');
}

/**
 * Parses a model response into a proposal. Returns null if the model
 * said NO_CHANGE, returned an empty identity block, or produced output
 * the parser cannot recognise. The parser is intentionally strict — a
 * malformed response should drop the proposal, not mutate identity.
 */
export function parseProposalResponse(
  response: string,
  before: string,
): { after: string; rationale: string } | null {
  const trimmed = response.trim();
  if (!trimmed) return null;
  if (trimmed === NO_CHANGE_SENTINEL) return null;
  const identityMatch = trimmed.match(/```identity\s*\n([\s\S]*?)\n```/);
  if (!identityMatch) return null;
  const after = identityMatch[1].trim();
  if (!after) return null;
  if (after === before.trim()) return null;
  const rationaleMatch = trimmed.match(/```rationale\s*\n([\s\S]*?)\n```/);
  const rationale = rationaleMatch ? rationaleMatch[1].trim() : '';
  return { after, rationale };
}

/**
 * Asks the model whether USER.md should be updated. Returns a proposal
 * or null. Pure: does not write anything.
 */
export async function proposeUserUpdate(
  projectDir: string,
  observations: string,
  callModel: (prompt: string) => Promise<string>,
): Promise<IdentityProposal | null> {
  const before = await readIdentityFile(projectDir, 'USER.md');
  const prompt = buildProposalPrompt('USER', before, observations);
  const response = await callModel(prompt);
  const parsed = parseProposalResponse(response, before);
  if (!parsed) return null;
  return { target: 'USER', before, after: parsed.after, rationale: parsed.rationale };
}

/**
 * Applies a USER.md proposal: captures a snapshot first, then writes
 * the new content. Returns the snapshot id used for the backup so the
 * change can be reverted via restoreIdentityFromHistory.
 */
export async function applyUserProposal(
  projectDir: string,
  proposal: IdentityProposal,
  now: Date = new Date(),
): Promise<{ snapshotId: string }> {
  if (proposal.target !== 'USER') {
    throw new Error('applyUserProposal requires a USER proposal');
  }
  const backup = await captureIdentitySnapshot(projectDir, 'pre-user-update', now);
  await writeIdentityFile(projectDir, 'USER.md', proposal.after);
  return { snapshotId: backup.id };
}

/**
 * Asks the model whether SOUL.md should drift. If yes, writes the
 * proposal to SOUL.proposed.md. NEVER writes SOUL.md directly —
 * acceptance is a separate, explicit step.
 */
export async function proposeSoulUpdate(
  projectDir: string,
  observations: string,
  callModel: (prompt: string) => Promise<string>,
  now: Date = new Date(),
): Promise<SoulProposalRecord | null> {
  const before = await readIdentityFile(projectDir, 'SOUL.md');
  const prompt = buildProposalPrompt('SOUL', before, observations);
  const response = await callModel(prompt);
  const parsed = parseProposalResponse(response, before);
  if (!parsed) return null;
  const capturedAt = now.toISOString();
  const record: SoulProposalRecord = {
    target: 'SOUL',
    before,
    after: parsed.after,
    rationale: parsed.rationale,
    capturedAt,
  };
  await writeSoulProposalFile(projectDir, record);
  return record;
}

async function writeSoulProposalFile(projectDir: string, record: SoulProposalRecord): Promise<void> {
  const header = [
    '---',
    `capturedAt: ${record.capturedAt}`,
    'proposedBy: auto',
    'target: SOUL.md',
    '---',
    '',
    '> This is a *proposed* SOUL.md update. SOUL.md itself is unchanged.',
    '> Review the rationale and the proposed body below, then either',
    '> run acceptSoulProposal() or discardSoulProposal().',
    '',
    '## Rationale',
    '',
    record.rationale || '_(none provided)_',
    '',
    '## Proposed SOUL.md',
    '',
    record.after,
    '',
  ].join('\n');
  const fp = soulProposalPath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, header, 'utf-8');
}

/**
 * Reads the pending SOUL proposal, if any. Returns null when no file
 * exists or when the file cannot be parsed.
 */
export async function readSoulProposal(projectDir: string): Promise<SoulProposalRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(soulProposalPath(projectDir), 'utf-8');
  } catch {
    return null;
  }
  const frontMatchEnd = raw.indexOf('\n---', 4);
  if (!raw.startsWith('---\n') || frontMatchEnd === -1) return null;
  const front = raw.slice(4, frontMatchEnd);
  const body = raw.slice(frontMatchEnd + 4);
  const meta: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const rationaleMatch = body.match(/## Rationale\s*\n+([\s\S]*?)\n+## Proposed SOUL\.md/);
  const proposedMatch = body.match(/## Proposed SOUL\.md\s*\n+([\s\S]*)$/);
  if (!proposedMatch) return null;
  const rationaleRaw = rationaleMatch ? rationaleMatch[1].trim() : '';
  const rationale = rationaleRaw === '_(none provided)_' ? '' : rationaleRaw;
  const after = proposedMatch[1].trim();
  if (!after) return null;
  const before = await readIdentityFile(projectDir, 'SOUL.md');
  return {
    target: 'SOUL',
    before,
    after,
    rationale,
    capturedAt: meta['capturedAt'] || '',
  };
}

/**
 * Accepts the pending SOUL proposal: captures a snapshot, writes
 * SOUL.md, removes the proposal file. Returns null if no proposal
 * exists.
 */
export async function acceptSoulProposal(
  projectDir: string,
  now: Date = new Date(),
): Promise<{ snapshotId: string } | null> {
  const proposal = await readSoulProposal(projectDir);
  if (!proposal) return null;
  const backup = await captureIdentitySnapshot(projectDir, 'pre-soul-accept', now);
  await writeIdentityFile(projectDir, 'SOUL.md', proposal.after);
  try {
    await fs.unlink(soulProposalPath(projectDir));
  } catch {
    // Already gone — fine.
  }
  return { snapshotId: backup.id };
}

/**
 * Discards the pending SOUL proposal. Returns true if a proposal was
 * removed, false if there was nothing to remove.
 */
export async function discardSoulProposal(projectDir: string): Promise<boolean> {
  try {
    await fs.unlink(soulProposalPath(projectDir));
    return true;
  } catch {
    return false;
  }
}
