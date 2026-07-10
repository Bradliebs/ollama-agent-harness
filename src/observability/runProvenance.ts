// ─── Run provenance ─────────────────────────────────────────────────────
//
// Auditable provenance for a run's artifacts: which model produced the run,
// when, and from what sources (tools, commands, files). This is the data
// spine behind the "where did this come from?" question — it lets a user
// trace an answer back to the model and the concrete steps that fed it.
//
// The guiding principle is honesty over completeness, mirroring
// costProvenance and answerConfidence:
//
//  - We NEVER fabricate a model name or timestamp. When the evidence card
//    did not record one, we report `null` rather than guessing.
//  - A source is marked `proven` ONLY when the card carries positive
//    success/verification evidence for it. A tool with success=false, a
//    command without a known result, or a file with an `unknown` action is
//    recorded but NOT claimed as proven.
//  - Provenance is recorded at RUN granularity, not per individual artifact.
//    The evidence card does not map a specific tool to a specific artifact,
//    so claiming per-artifact source linkage would be fabricated precision.
//    We list the run's artifacts alongside the provenance that produced
//    them, which is the linkage we can actually prove.
//
// Design constraints:
//  - Pure: no I/O, no clock, no global state. Fully unit-testable.
//  - Type-only dependency on EvidenceCard; no runtime coupling.

import type { EvidenceCard } from '../types/evidence';

/** What kind of run step a provenance source came from. */
export type ProvenanceSourceKind = 'tool' | 'command' | 'file';

export interface ProvenanceSource {
  kind: ProvenanceSourceKind;
  /** Tool name, command line, or file path. */
  label: string;
  /** True ONLY when the card carries positive success/verification evidence. */
  proven: boolean;
}

export interface RunProvenance {
  /** The evidence card id the provenance was derived from. */
  runId: string;
  /** Model that produced the run — null when the card did not record one. */
  model: string | null;
  /** ISO timestamp the run was recorded — null when the card did not record one. */
  recordedAt: string | null;
  /** Tools, commands, and files that fed the run, in run order. Not deduplicated. */
  sources: ProvenanceSource[];
  /** Artifacts the run produced, paired with (not individually linked to) the above. */
  artifacts: Array<{ title: string; kind: string }>;
  /** True when both model and recordedAt are present — a fully attributable run. */
  complete: boolean;
  /** Plain-language, honest summary suitable for a badge tooltip. */
  reason: string;
}

/** Normalise a possibly-empty string to a trimmed value or null — never a guess. */
function presentOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Build an honest, auditable provenance record for a run from its evidence
 * card. Reports `null` for an unrecorded model/time rather than fabricating
 * one, and marks a source `proven` only when positive evidence exists.
 */
export function buildRunProvenance(card: EvidenceCard): RunProvenance {
  const model = presentOrNull(card.model);
  const recordedAt = presentOrNull(card.createdAt);

  const sources: ProvenanceSource[] = [
    ...card.tools.map<ProvenanceSource>((t) => ({
      kind: 'tool',
      label: t.name,
      proven: t.success,
    })),
    ...card.commands.map<ProvenanceSource>((c) => ({
      kind: 'command',
      label: c.command,
      // success is optional; only a definite `true` counts as proven.
      proven: c.success === true,
    })),
    ...card.files.map<ProvenanceSource>((f) => ({
      kind: 'file',
      label: f.path,
      // An 'unknown' action means we did not record what happened to the
      // file, so it cannot be claimed as a proven source.
      proven: f.action !== 'unknown',
    })),
  ];

  const complete = model !== null && recordedAt !== null;
  const provenCount = sources.filter((s) => s.proven).length;

  const parts = [
    model ? `model ${model}` : 'model not recorded',
    recordedAt ? `at ${recordedAt}` : 'time not recorded',
    sources.length
      ? `${sources.length} source${sources.length === 1 ? '' : 's'} (${provenCount} proven)`
      : 'no sources recorded',
  ];
  const reason = `${complete ? 'Provenance complete' : 'Provenance partial'}: ${parts.join(', ')}.`;

  return {
    runId: card.id,
    model,
    recordedAt,
    sources,
    artifacts: card.artifacts.map((a) => ({ title: a.title, kind: a.kind })),
    complete,
    reason,
  };
}
