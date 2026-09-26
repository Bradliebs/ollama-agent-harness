// Critic model selection — the model that did the work never grades it.
//
// The critic is picked from a different model family than the worker,
// preferring a cheap cloud model. Candidates are tried in order at call time,
// so a retired or unavailable model (they do disappear: deepseek-v4-flash was
// retired on 2026-09-25) is skipped instead of breaking verification.

export const DEFAULT_CRITIC_PREFERENCE = [
  'deepseek-v4-flash:cloud',
  'minimax-m2.7:cloud',
  'glm-5.3-flash:cloud',
  'kimi-k3:cloud',
  'qwen3.5:397b-cloud',
  'nemotron-3-super:cloud',
  'gemma4:31b-cloud',
  'deepseek-v4-pro:cloud',
  'qwen3.6:27b',
  'gemma4:26b',
];

const FAMILY_ALIASES: Record<string, string> = {
  ministral: 'mistral',
  codestral: 'mistral',
  mixtral: 'mistral',
  chatgpt: 'gpt',
  o: 'gpt',
};

/** Model family: "openrouter/anthropic/claude-sonnet-4.5" -> "claude", "qwen3.6:27b" -> "qwen". */
export function modelFamily(model: string): string {
  const base = model.trim().toLowerCase().split('/').pop() ?? '';
  const letters = base.match(/^[a-z]+/)?.[0] ?? base;
  return FAMILY_ALIASES[letters] ?? letters;
}

export interface CriticSelection {
  /** Candidates in the order they should be tried. */
  candidates: string[];
  /** Why an override was ignored, if it was. */
  rejected?: string;
}

/**
 * Order critic candidates for a worker model. `override` (HARNESS_CRITIC_MODEL
 * or a setting) goes first unless it shares the worker's family. When
 * `available` is given, candidates not in it are dropped.
 */
export function selectCriticCandidates(
  workerModel: string,
  options: { override?: string; available?: string[]; preference?: string[] } = {},
): CriticSelection {
  const workerFamily = modelFamily(workerModel);
  const available = options.available ? new Set(options.available) : null;
  const ordered: string[] = [];
  let rejected: string | undefined;
  const override = options.override?.trim();
  if (override) {
    if (modelFamily(override) === workerFamily) rejected = `Critic ${override} is the same family (${workerFamily}) as the worker; using another family.`;
    else ordered.push(override);
  }
  for (const candidate of options.preference ?? DEFAULT_CRITIC_PREFERENCE) {
    if (modelFamily(candidate) === workerFamily) continue;
    if (available && !available.has(candidate)) continue;
    if (!ordered.includes(candidate)) ordered.push(candidate);
  }
  return { candidates: ordered, ...(rejected ? { rejected } : {}) };
}
