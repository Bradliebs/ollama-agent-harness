// Verified-merge decision kernel — the gate for Phase 4 parallelism.
//
// Parallel workstreams may *complete* (produce output) without their work being
// *verified*. Merging completed-but-unverified branches is how speculative
// parallelism quietly becomes a liability. This pure kernel decides which
// branches are eligible to merge, gated on a verification verdict: a branch
// merges ONLY if it both completed AND verified `pass`. Anything else — failed,
// warned, skipped, or no verdict at all — is rejected. The safe default is to
// NOT merge unproven work, the same trust-first posture as the cost kernel's
// "don't claim $0 without proof".

import type { VerificationStatus } from '../core/doneStateVerifier';

export interface BranchVerification {
  /** Workstream / branch id. */
  id: string;
  /** Did the branch run to completion (produced output, no error)? */
  completed: boolean;
  /** Verification verdict for the branch's work, if one was produced. */
  verification?: VerificationStatus;
}

export interface MergeDecision {
  id: string;
  mergeable: boolean;
  reason: string;
}

export interface VerifiedMergePlan {
  /** Branches eligible to merge (completed AND verified `pass`). */
  mergeable: MergeDecision[];
  /** Branches excluded from the merge, each with a reason. */
  rejected: MergeDecision[];
  /**
   * Atomic gate for "merge only if both verify": true when there is at least one
   * branch and every branch is mergeable. A consumer doing an all-or-nothing
   * merge checks this; a consumer taking only the winners uses `mergeable`.
   */
  allVerified: boolean;
}

function decide(branch: BranchVerification): MergeDecision {
  const { id } = branch;
  if (!branch.completed) {
    return { id, mergeable: false, reason: 'did not complete — nothing to merge' };
  }
  switch (branch.verification) {
    case 'pass':
      return { id, mergeable: true, reason: 'completed and verified — safe to merge' };
    case 'fail':
      return { id, mergeable: false, reason: 'verification failed — not merging broken work' };
    case 'warn':
      return { id, mergeable: false, reason: 'verification warned — not proven safe to merge' };
    case 'skip':
      return { id, mergeable: false, reason: 'verification skipped — no proof to merge on' };
    default:
      return { id, mergeable: false, reason: 'completed but unverified — not merging without proof' };
  }
}

/**
 * Decide which parallel branches may merge. Pure: no I/O, no side effects.
 * The verification verdict comes from the existing doneStateVerifier vocabulary
 * so there is a single source of truth for what "verified" means.
 */
export function planVerifiedMerge(branches: BranchVerification[]): VerifiedMergePlan {
  const decisions = branches.map(decide);
  const mergeable = decisions.filter((d) => d.mergeable);
  const rejected = decisions.filter((d) => !d.mergeable);
  return {
    mergeable,
    rejected,
    allVerified: decisions.length > 0 && rejected.length === 0,
  };
}
