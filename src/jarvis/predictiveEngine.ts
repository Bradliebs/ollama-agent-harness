// Predictive Next-Action Engine.
//
// Mines completed evidence (chat tool sequences, learning candidates, ambient
// signals) for short Markov-style patterns:
//
//   "after the user does X, they usually do Y within N steps"
//
// Emits NextActionSuggestion records that Mission Control can render as
// Accept / Dismiss buttons. Suggestions never execute on their own — they pass
// through the Trust Ladder. A capability at rung 4 (act) may auto-execute,
// everything else surfaces a card.
//
// Pure pattern miner — no LLM calls. Fast, deterministic, explainable.
// LLM-shaped suggestions can be layered on top later by feeding the same
// evidence stream into a small router model.

export interface ActionEvent {
  /** Stable identifier for the action, e.g. tool name or signal type. */
  key: string;
  /** Optional human label. */
  label?: string;
  /** ISO timestamp. */
  at: string;
  /** Optional capability name used to gate execution via the Trust Ladder. */
  capability?: string;
  /** Free-form metadata for the suggestion card. */
  metadata?: Record<string, unknown>;
}

export interface NextActionSuggestion {
  trigger: string;
  predicted: string;
  confidence: number;
  sampleSize: number;
  capability?: string;
  rationale: string;
}

export interface MineOptions {
  /** Maximum lookahead window when scanning for "X then Y". */
  windowSize?: number;
  /** Minimum number of observed transitions before a suggestion is allowed. */
  minSamples?: number;
  /** Minimum confidence (transition count / total trigger count). */
  minConfidence?: number;
  /** Cap on how many suggestions to return. */
  limit?: number;
}

const DEFAULT_WINDOW = 3;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_MIN_CONFIDENCE = 0.4;
const DEFAULT_LIMIT = 10;

/**
 * Scan a chronological list of action events and return the top N
 * "after X usually Y" suggestions, sorted by confidence × sampleSize.
 */
export function mineNextActions(events: ActionEvent[], options: MineOptions = {}): NextActionSuggestion[] {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const limit = options.limit ?? DEFAULT_LIMIT;

  // count[trigger][predicted] = transitions
  const count = new Map<string, Map<string, number>>();
  const triggerTotal = new Map<string, number>();
  // capability lookup: predicted key → most recent capability seen
  const capabilityFor = new Map<string, string | undefined>();

  for (let i = 0; i < events.length; i++) {
    const trigger = events[i];
    capabilityFor.set(trigger.key, trigger.capability);
    const seen = new Set<string>();
    for (let j = i + 1; j < Math.min(events.length, i + 1 + windowSize); j++) {
      const next = events[j];
      if (next.key === trigger.key || seen.has(next.key)) continue;
      seen.add(next.key);
      const inner = count.get(trigger.key) ?? new Map<string, number>();
      inner.set(next.key, (inner.get(next.key) ?? 0) + 1);
      count.set(trigger.key, inner);
      triggerTotal.set(trigger.key, (triggerTotal.get(trigger.key) ?? 0) + 1);
      capabilityFor.set(next.key, next.capability);
    }
  }

  const suggestions: NextActionSuggestion[] = [];
  for (const [trigger, inner] of count.entries()) {
    const total = triggerTotal.get(trigger) ?? 0;
    for (const [predicted, transitions] of inner.entries()) {
      if (transitions < minSamples) continue;
      const confidence = total > 0 ? transitions / total : 0;
      if (confidence < minConfidence) continue;
      suggestions.push({
        trigger,
        predicted,
        confidence,
        sampleSize: transitions,
        capability: capabilityFor.get(predicted),
        rationale: `Observed ${transitions}/${total} times within ${windowSize} steps after \`${trigger}\``,
      });
    }
  }

  suggestions.sort((a, b) => b.confidence * b.sampleSize - a.confidence * a.sampleSize);
  return suggestions.slice(0, limit);
}

/**
 * Convenience: given the latest action and a precomputed suggestion set,
 * return the highest-confidence next action keyed off it. Used by Mission
 * Control to surface a card right after a tool call completes.
 */
export function suggestNextAfter(latestKey: string, suggestions: NextActionSuggestion[]): NextActionSuggestion | undefined {
  return suggestions.find((s) => s.trigger === latestKey);
}
