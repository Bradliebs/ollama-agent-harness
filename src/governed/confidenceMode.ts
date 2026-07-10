// Governed Agent Loop — confidence-mode taxonomy.
//
// Every answer the harness produces can be labelled with HOW it knows what it
// says, not just a numeric score. The four modes mirror an honest consultant:
// settled knowledge, the model's own reasoning, fresh-but-unverified web
// findings, and "do not trust this yet". This is a pure classifier over signals
// the harness already computes (citations, web sources, confidence, abstention,
// source conflict). It never mutates anything.

export type ConfidenceMode = 'from-brain' | 'inferred' | 'found-online-unsaved' | 'needs-review';

export interface ConfidenceModeSignals {
  /** Number of stored brain/memory citations backing the answer. */
  brainCitations?: number;
  /** Number of web/search sources used but not yet imported into the brain. */
  unsavedWebSources?: number;
  /** Model/retrieval confidence 0–1 (1 = certain). */
  confidence?: number;
  /** The answer abstained / declined to commit. */
  abstained?: boolean;
  /** Sources disagreed with each other. */
  conflict?: boolean;
}

export interface ConfidenceModeResult {
  mode: ConfidenceMode;
  reason: string;
}

// Matches the modelRouting confidence-escalation default so the two governance
// surfaces agree on what "low confidence" means.
export const DEFAULT_REVIEW_THRESHOLD = 0.45;

export function classifyConfidenceMode(
  signals: ConfidenceModeSignals,
  reviewThreshold: number = DEFAULT_REVIEW_THRESHOLD,
): ConfidenceModeResult {
  const { brainCitations = 0, unsavedWebSources = 0, confidence = 1, abstained = false, conflict = false } = signals;

  // Highest priority: anything that must not become knowledge as-is.
  if (abstained) return { mode: 'needs-review', reason: 'answer abstained from committing' };
  if (conflict) return { mode: 'needs-review', reason: 'sources conflicted' };
  if (confidence < reviewThreshold) {
    return { mode: 'needs-review', reason: `confidence ${confidence.toFixed(2)} below ${reviewThreshold}` };
  }

  // Fresh web findings that have not been staged into the brain yet.
  if (unsavedWebSources > 0 && brainCitations === 0) {
    return { mode: 'found-online-unsaved', reason: `${unsavedWebSources} web source(s) not yet imported to brain` };
  }

  // Grounded in settled, stored knowledge.
  if (brainCitations > 0) return { mode: 'from-brain', reason: `${brainCitations} brain citation(s)` };

  // No citations, adequate confidence: this is the model's own reasoning.
  return { mode: 'inferred', reason: 'no citations; model reasoning' };
}
