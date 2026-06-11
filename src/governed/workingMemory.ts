// Governed Agent Loop — unified working-memory surface.
//
// The pieces of "what the agent is currently holding in its head" already exist
// on a ContinuityCheckpoint (currentGoal, openQuestions, nextAction,
// pendingToolCalls). This module assembles them into one inspectable object so a
// human can see the agent's goal, assumptions, open questions, decisions, next
// action, and blocked items at a glance. Pure mapping — no I/O.

import type { ContinuityCheckpoint } from '../types';

export interface WorkingMemory {
  currentGoal: string;
  assumptions: string[];
  openQuestions: string[];
  decisions: string[];
  nextAction: string;
  blocked: string[];
  updatedAt: string;
}

export interface WorkingMemoryExtras {
  /** Assumptions the agent is operating under (not carried on the checkpoint). */
  assumptions?: string[];
  /** Decisions made this session (not carried on the checkpoint). */
  decisions?: string[];
  /** Explicitly blocked items; defaults to derived pending tool calls. */
  blocked?: string[];
}

export function buildWorkingMemory(
  checkpoint: ContinuityCheckpoint,
  extras: WorkingMemoryExtras = {},
): WorkingMemory {
  return {
    currentGoal: checkpoint.currentGoal,
    assumptions: extras.assumptions ?? [],
    openQuestions: checkpoint.openQuestions ?? [],
    decisions: extras.decisions ?? [],
    nextAction: checkpoint.nextAction,
    blocked: extras.blocked ?? deriveBlocked(checkpoint),
    updatedAt: checkpoint.timestamp,
  };
}

// Pending tool calls that never completed are the closest signal a checkpoint
// carries for "blocked / waiting on" items.
function deriveBlocked(checkpoint: ContinuityCheckpoint): string[] {
  return (checkpoint.pendingToolCalls ?? []).map((name) => `pending: ${name}`);
}
