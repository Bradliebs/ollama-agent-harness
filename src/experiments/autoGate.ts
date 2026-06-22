// Auto-gated prompt promotion.
//
// The harness learns from past sessions and accumulates an "evolved prompt"
// (src/learning/engine.ts). That evolved prompt is already applied in the CHAT
// path, but applying it to the AUTONOMY path is riskier: a regressed prompt
// silently degrades every unattended build. This module is the safety gate in
// front of that promotion.
//
// It does NOT re-implement evaluation. It is a thin orchestrator that reuses
// the existing experiment runner (runExperiment -> runBenchmark -> McNemar
// paired scoring + guardrails + safety evidence). All this module adds is:
//   1. building a baseline-vs-candidate manifest from two system prompts, and
//   2. fail-closed interpretation of the result into an approval marker that
//      the autonomy path (Phase 2) consumes.
//
// Fail-closed means: anything other than a clear, guardrail-passing win keeps
// the baseline. Errors, inconclusive runs, and regressions all reject. The
// autonomy path only ever applies a candidate prompt that this gate explicitly
// approved AND whose content still hashes to the approved value.

import { runExperiment, type RunExperimentResult } from './runner';
import {
  APPROVAL_MARKER_RELPATH,
  hashPrompt,
  readApprovalMarker,
  writeApprovalMarker,
  type PromptApprovalMarker,
} from '../learning/promptApproval';
import type {
  ExperimentExecutionRecord,
  ExperimentGuardrails,
  ExperimentManifest,
} from './types';

export { APPROVAL_MARKER_RELPATH, hashPrompt, readApprovalMarker } from '../learning/promptApproval';
export type { PromptApprovalMarker } from '../learning/promptApproval';

/**
 * Conservative defaults for a prompt that is about to drive unattended builds:
 * require at least one net paired win, no safety regressions, and no large
 * latency blow-up. Callers may override per-field.
 */
export const DEFAULT_PROMPT_GATE_GUARDRAILS: ExperimentGuardrails = {
  minCandidateNetWins: 1,
  requireNoSafetyRegressions: true,
  maxLatencyRegressionRatio: 1.5,
};

export interface PromptGateInput {
  projectDir: string;
  /** Current/known-good system prompt (the baseline that stays on a reject). */
  basePrompt: string;
  /** Evolved system prompt under evaluation. */
  candidatePrompt: string;
  /** Frozen benchmark dataset the gate evaluates against. */
  datasetId: string;
  /** Scorer version recorded with the experiment. */
  scorerVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Override the conservative default guardrails. */
  guardrails?: ExperimentGuardrails;
  now?: () => Date;
  /** Injectable for tests; defaults to the real runExperiment. */
  runExperimentImpl?: typeof runExperiment;
  /** Persist the experiment record + approval marker. Default true. */
  persist?: boolean;
}

export type PromptGateDecision =
  | {
      status: 'promoted';
      /** The prompt the caller should use: the candidate. */
      prompt: string;
      marker: PromptApprovalMarker;
      record: ExperimentExecutionRecord;
      reasons: string[];
    }
  | {
      status: 'rejected';
      /** The prompt the caller should use: the safe baseline. */
      prompt: string;
      record?: ExperimentExecutionRecord;
      reasons: string[];
    }
  | {
      status: 'unchanged';
      /** Candidate equals baseline; nothing to gate. */
      prompt: string;
      reasons: string[];
    };

/**
 * Build a baseline-vs-candidate manifest from two system prompts. Pure; no I/O.
 * The only mutated scope is the prompt, and the rollback target is the baseline.
 */
export function buildPromptGateManifest(input: {
  basePrompt: string;
  candidatePrompt: string;
  datasetId: string;
  scorerVersion?: string;
  guardrails?: ExperimentGuardrails;
  createdAt?: string;
}): ExperimentManifest {
  return {
    id: `prompt-gate-${hashPrompt(input.candidatePrompt).slice(0, 12)}`,
    hypothesis: 'Evolved system prompt improves autonomy outcomes without safety or latency regression.',
    expectedMechanism: 'Learned instructions sharpen agent behaviour on the frozen benchmark.',
    allowedMutationScopes: ['prompt'],
    rollbackTarget: 'autonomy-prompt-baseline',
    baseline: {
      id: 'autonomy-prompt-baseline',
      label: 'Current autonomy prompt',
      systemPrompt: input.basePrompt,
    },
    candidate: {
      id: 'autonomy-prompt-evolved',
      label: 'Evolved autonomy prompt',
      systemPrompt: input.candidatePrompt,
    },
    evaluation: {
      datasetId: input.datasetId,
      scorerVersion: input.scorerVersion ?? 'auto-gate-1',
    },
    guardrails: input.guardrails ?? DEFAULT_PROMPT_GATE_GUARDRAILS,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

/**
 * Interpret a completed experiment record into a gate verdict. Pure; no I/O.
 * Promotes only when the experiment's own promotion evidence says automatic
 * promotion is allowed. Everything else (inconclusive, regressed, missing
 * evidence) is a reject.
 */
export function interpretGateResult(record: ExperimentExecutionRecord): {
  promote: boolean;
  reasons: string[];
  passRateDelta: number;
  netCandidateWins: number;
} {
  const evidence = record.promotionEvidence;
  if (!evidence) {
    return { promote: false, reasons: ['No promotion evidence on experiment record.'], passRateDelta: 0, netCandidateWins: 0 };
  }
  return {
    promote: evidence.automaticPromotionAllowed,
    reasons: evidence.reasons.length > 0 ? [...evidence.reasons] : [evidence.status],
    passRateDelta: evidence.passRateDelta,
    netCandidateWins: evidence.netCandidateWins,
  };
}

/**
 * Run the gate. Returns the prompt the caller should adopt plus the verdict.
 * Fail-closed: on identical prompts -> unchanged (baseline); on any failure or
 * non-winning result -> rejected (baseline); only a guardrail-passing win ->
 * promoted (candidate) AND an approval marker written for the autonomy path.
 */
export async function gateEvolvedPrompt(input: PromptGateInput): Promise<PromptGateDecision> {
  if (input.candidatePrompt.trim() === input.basePrompt.trim()) {
    return { status: 'unchanged', prompt: input.basePrompt, reasons: ['Candidate prompt is identical to baseline.'] };
  }

  const persist = input.persist ?? true;
  const run = input.runExperimentImpl ?? runExperiment;
  const manifest = buildPromptGateManifest({
    basePrompt: input.basePrompt,
    candidatePrompt: input.candidatePrompt,
    datasetId: input.datasetId,
    scorerVersion: input.scorerVersion,
    guardrails: input.guardrails,
    createdAt: input.now ? input.now().toISOString() : undefined,
  });

  let result: RunExperimentResult;
  try {
    result = await run({
      projectDir: input.projectDir,
      manifest,
      baseUrl: input.baseUrl,
      fetchImpl: input.fetchImpl,
      persist,
      now: input.now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'rejected', prompt: input.basePrompt, reasons: [`Experiment failed: ${message}`] };
  }

  if (result.type !== 'completed') {
    return { status: 'rejected', prompt: input.basePrompt, reasons: ['Experiment did not complete (dry run).'] };
  }

  const verdict = interpretGateResult(result.record);
  if (!verdict.promote) {
    return { status: 'rejected', prompt: input.basePrompt, record: result.record, reasons: verdict.reasons };
  }

  const marker: PromptApprovalMarker = {
    approvedPromptHash: hashPrompt(input.candidatePrompt),
    approvedAt: (input.now ? input.now() : new Date()).toISOString(),
    experimentId: result.record.id,
    passRateDelta: verdict.passRateDelta,
    netCandidateWins: verdict.netCandidateWins,
    reasons: verdict.reasons,
  };
  if (persist) await writeApprovalMarker(input.projectDir, marker);

  return { status: 'promoted', prompt: input.candidatePrompt, marker, record: result.record, reasons: verdict.reasons };
}
