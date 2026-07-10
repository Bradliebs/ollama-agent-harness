// Governed Agent Loop v1 — one deterministic governance pass.
//
// Composes the loop the vision asks for: an already-produced answer is wrapped
// with HOW it knows (confidence mode), a self-critique, the current working
// memory, and STAGED brain-update proposals (never auto-written — proposals are
// review artifacts, not writes). The function is pure and model-free: the
// `answer` string is passed through untouched, so this can run beside the
// product path without changing the default answer contract (shadow-first).

import { classifyConfidenceMode, type ConfidenceModeResult, type ConfidenceModeSignals } from './confidenceMode';
import { selfCritique, type SelfCritiqueResult } from './selfCritique';
import { buildWorkingMemory, type WorkingMemory, type WorkingMemoryExtras } from './workingMemory';
import type { ContinuityCheckpoint } from '../types';

export interface BrainUpdateProposal {
  content: string;
  reason: string;
}

export interface GovernedAnswerInput {
  /** The answer text already produced by the product path; passed through. */
  answer: string;
  signals: ConfidenceModeSignals;
  /** Optional checkpoint to derive the working-memory snapshot from. */
  checkpoint?: ContinuityCheckpoint;
  workingMemoryExtras?: WorkingMemoryExtras;
  /** Candidate facts to stage for human approval. Never auto-applied. */
  brainUpdateCandidates?: BrainUpdateProposal[];
  /** Age of the oldest relied-on source in ms, for the freshness critique. */
  oldestSourceAgeMs?: number;
  /** Assumptions the answer rests on, for the self-critique. */
  assumptions?: string[];
}

export interface GovernedAnswer {
  answer: string;
  confidence: ConfidenceModeResult;
  critique: SelfCritiqueResult;
  workingMemory: WorkingMemory | null;
  /** Staged proposals awaiting human approval — never written by this pass. */
  proposedBrainUpdates: BrainUpdateProposal[];
}

export function governAnswer(input: GovernedAnswerInput): GovernedAnswer {
  const confidence = classifyConfidenceMode(input.signals);
  const critique = selfCritique({
    confidenceMode: confidence.mode,
    citations: (input.signals.brainCitations ?? 0) + (input.signals.unsavedWebSources ?? 0),
    oldestSourceAgeMs: input.oldestSourceAgeMs,
    assumptions: input.assumptions,
    conflict: input.signals.conflict,
  });
  const workingMemory = input.checkpoint
    ? buildWorkingMemory(input.checkpoint, input.workingMemoryExtras)
    : null;

  return {
    answer: input.answer,
    confidence,
    critique,
    workingMemory,
    // Proposals are staged review artifacts; this pass never writes them.
    proposedBrainUpdates: input.brainUpdateCandidates ?? [],
  };
}
