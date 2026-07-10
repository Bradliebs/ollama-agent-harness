// ─── Answer confidence & abstention ─────────────────────────────────────
//
// Honest, answer-time confidence signal for a model's final reply. This is
// the data spine behind a "calibrated confidence / abstention" surface: it
// answers, for a given answer, whether the model *abstained* ("I don't know
// / I need more information"), *stated* an explicit confidence, or said
// nothing about its certainty at all.
//
// The guiding principle is honesty over false precision — the same stance
// costProvenance takes toward "$0 marginal":
//   - We NEVER fabricate a confidence number the model did not state. When
//     no confidence is expressed we return band 'unstated', not a guessed
//     decimal. A made-up 0.5 would be indistinguishable from a real one.
//   - Abstention is a FIRST-CLASS outcome, not a synonym for "low
//     confidence". An agent that honestly declines ("I don't know") is
//     behaving correctly; collapsing that into a low score would hide the
//     single most useful trust signal a local agent can give.
//   - Detection is conservative: only explicit, unambiguous phrases count.
//     A false abstention (treating a hedged-but-answered reply as a
//     decline) is worse than missing a borderline one.
//
// Design constraints:
//  - Pure: no I/O, no clock, no global state. Fully unit-testable.
//  - String-in, verdict-out. No coupling to any client or transport.

/** Coarse, honest confidence band for a model's answer. */
export type ConfidenceBand = 'high' | 'medium' | 'low' | 'abstained' | 'unstated';

export interface AnswerConfidence {
  /** The honest band. 'unstated' when the model expressed no confidence. */
  band: ConfidenceBand;
  /** True when the model explicitly declined or asked for more information. */
  abstained: boolean;
  /** The self-reported confidence (0–1) when the model stated one; else null. */
  statedScore: number | null;
  /** Plain-language explanation of how the band was decided. */
  reason: string;
}

// Explicit abstention phrases. Conservative on purpose: each is a clear
// decline or request for more input, not mere hedging ("probably", "I think").
const ABSTENTION_SIGNALS: readonly string[] = [
  "i don't know",
  'i do not know',
  'i cannot determine',
  "i can't determine",
  'cannot be determined',
  'not enough information',
  'insufficient information',
  'unable to answer',
  'i need more information',
  'i need more context',
  'cannot answer',
];

/** Map an explicit 0–1 score to a coarse band. Thresholds documented inline. */
export function classifyConfidenceScore(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.75) return 'high'; // >=0.75 -> high
  if (score >= 0.4) return 'medium'; // [0.4, 0.75) -> medium
  return 'low'; // <0.4 -> low
}

/**
 * Detect an explicit abstention in a model reply. Returns the matched signal
 * phrase when found. Case-insensitive; matches the FIRST listed signal so the
 * reason is deterministic.
 */
export function detectAbstention(text: string): { abstained: boolean; signal?: string } {
  const haystack = text.toLowerCase();
  for (const signal of ABSTENTION_SIGNALS) {
    if (haystack.includes(signal)) return { abstained: true, signal };
  }
  return { abstained: false };
}

// Parses an explicit self-reported confidence: "confidence: 0.8",
// "confidence 80%", "confidence: high". Returns a 0–1 score, or null when no
// explicit statement is present (we do NOT infer one from tone).
const CONFIDENCE_DECIMAL = /confidence[:\s]+(\d(?:\.\d+)?|0?\.\d+)\b/i;
const CONFIDENCE_PERCENT = /confidence[:\s]+(\d{1,3})\s*%/i;

export function parseStatedConfidence(text: string): number | null {
  const pct = text.match(CONFIDENCE_PERCENT);
  if (pct) {
    const n = Number(pct[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n / 100;
  }
  const dec = text.match(CONFIDENCE_DECIMAL);
  if (dec) {
    const n = Number(dec[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return null;
}

/**
 * Assess an answer's confidence honestly. Precedence:
 *   1. Explicit abstention -> band 'abstained' (overrides any stated number;
 *      a model that says "I don't know, but maybe 0.6" has still declined).
 *   2. Explicit stated confidence -> band from classifyConfidenceScore.
 *   3. Neither -> band 'unstated' (no fabricated score).
 */
export function assessAnswerConfidence(text: string): AnswerConfidence {
  const abstention = detectAbstention(text);
  if (abstention.abstained) {
    return {
      band: 'abstained',
      abstained: true,
      statedScore: null,
      reason: `model abstained — matched "${abstention.signal}"`,
    };
  }

  const statedScore = parseStatedConfidence(text);
  if (statedScore !== null) {
    const band = classifyConfidenceScore(statedScore);
    return {
      band,
      abstained: false,
      statedScore,
      reason: `model stated confidence ${statedScore} -> ${band}`,
    };
  }

  return {
    band: 'unstated',
    abstained: false,
    statedScore: null,
    reason: 'model expressed no confidence — not inferring one',
  };
}
