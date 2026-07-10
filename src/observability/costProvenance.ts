// ─── Cost provenance ────────────────────────────────────────────────────
//
// Honest marginal-cost classification for a model call. This is the data
// spine behind the "100% local, $0 marginal" badge: it answers, for a
// given model, whether the harness can *prove* the call ran locally (and
// therefore cost nothing at the margin) or whether it went to a paid
// cloud provider.
//
// The guiding principle is honesty over marketing. We claim "$0 marginal"
// ONLY when locality is provable from the model registry. When a model is
// not in the registry we return `unknown` rather than guessing `local` —
// a later runtime slice can upgrade `unknown` to `local` using the
// authoritative signal of *which client* served the call (Ollama vs an
// OpenAI-compatible cloud client).
//
// We deliberately do NOT carry a per-token USD price table: the registry
// has no prices, and a hard-coded table would be speculative and quickly
// stale. So cloud calls report a known locality of `cloud` with an
// explicitly unknown dollar amount (`marginalCostUsd: null`) rather than a
// fabricated figure.
//
// Design constraints:
//  - Pure: no I/O, no clock, no global state. Fully unit-testable.
//  - Registry-injectable: defaults to the built-in registry, overridable
//    in tests and by callers with custom inventories.

import { BUILTIN_MODEL_REGISTRY, type ModelRegistryEntry } from '../models/modelRegistry';

/** Whether a model call ran on the user's machine, in the cloud, or cannot be proven. */
export type ModelLocality = 'local' | 'cloud' | 'unknown';

export interface MarginalCostVerdict {
  /** The model id/name the verdict was computed for. */
  model: string;
  /** Provable locality of the call. */
  locality: ModelLocality;
  /** True ONLY when locality is provably `local` — the honest "$0 marginal" claim. */
  freeMarginal: boolean;
  /** Marginal cost in USD: 0 when local; null when cloud or unknown (no price tracked). */
  marginalCostUsd: number | null;
  /** Plain-language, honest summary suitable for a badge tooltip. */
  reason: string;
}

/** Find a registry entry by `id` or `model_name`, case-insensitively. */
function findEntry(model: string, entries: ModelRegistryEntry[]): ModelRegistryEntry | undefined {
  const key = model.trim().toLowerCase();
  if (!key) return undefined;
  return entries.find(
    (e) => e.id.toLowerCase() === key || e.model_name.toLowerCase() === key,
  );
}

/**
 * Classify whether a model call is local, cloud, or of unprovable locality.
 * Resolves only from the registry — an unrecognised model is `unknown`, never
 * silently assumed local.
 */
export function classifyModelLocality(
  model: string,
  entries: ModelRegistryEntry[] = BUILTIN_MODEL_REGISTRY,
): ModelLocality {
  const entry = findEntry(model, entries);
  if (!entry) return 'unknown';
  if (entry.provider === 'ollama' || entry.privacy_level === 'local') return 'local';
  return 'cloud';
}

/**
 * Produce an honest marginal-cost verdict for a model call. Claims `$0` only
 * when locality is provably local; reports `null` (unknown amount) for cloud
 * and unknown models rather than fabricating a price.
 */
export function assessMarginalCost(
  model: string,
  entries: ModelRegistryEntry[] = BUILTIN_MODEL_REGISTRY,
): MarginalCostVerdict {
  const locality = classifyModelLocality(model, entries);
  if (locality === 'local') {
    return {
      model,
      locality,
      freeMarginal: true,
      marginalCostUsd: 0,
      reason: 'Served locally — $0 marginal cost and no data leaves your machine.',
    };
  }
  if (locality === 'cloud') {
    const provider = findEntry(model, entries)?.provider;
    return {
      model,
      locality,
      freeMarginal: false,
      marginalCostUsd: null,
      reason: `Cloud model${provider ? ` (${provider})` : ''} — billed per token by the provider; price not tracked locally.`,
    };
  }
  return {
    model,
    locality,
    freeMarginal: false,
    marginalCostUsd: null,
    reason: 'Unrecognised model — locality unknown; not claiming $0 without proof.',
  };
}

/** A single model call's contribution to a run, with locality already
 * resolved upstream (e.g. from the usage event's `locality` field). */
export interface RunUsageSample {
  locality: ModelLocality;
  promptTokens: number;
  completionTokens: number;
}

/** Honest run-level cost rollup across every model call in a run. */
export interface RunCostSummary {
  /** Number of model calls aggregated. */
  calls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  /** Run locality: `local` only when every call is provably local;
   * `cloud` if any call was cloud; otherwise `unknown`. */
  locality: ModelLocality;
  /** True ONLY when every call is provably local — the honest "$0 run" claim. */
  freeMarginal: boolean;
  /** Run marginal cost USD: 0 only when all-local; null otherwise (untracked). */
  marginalCostUsd: number | null;
  /** Plain-language, honest one-line summary suitable for a run cost badge. */
  reason: string;
}

/**
 * Fold a run's per-call usage samples into one honest cost verdict. Claims a
 * `$0` all-local run ONLY when every call is provably local; a single cloud
 * call makes the run billed, and any unprovable call keeps the run `unknown`
 * rather than fabricating a free claim. Pure: no I/O, no registry needed —
 * localities are already resolved upstream.
 */
export function summarizeRunCost(samples: RunUsageSample[]): RunCostSummary {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let anyCloud = false;
  let anyUnknown = false;
  let cloudCalls = 0;
  for (const s of samples) {
    totalPromptTokens += s.promptTokens;
    totalCompletionTokens += s.completionTokens;
    if (s.locality === 'cloud') {
      anyCloud = true;
      cloudCalls++;
    } else if (s.locality === 'unknown') {
      anyUnknown = true;
    }
  }
  const calls = samples.length;
  const totalTokens = totalPromptTokens + totalCompletionTokens;
  const base = { calls, totalPromptTokens, totalCompletionTokens, totalTokens };
  if (calls === 0) {
    return {
      ...base,
      locality: 'unknown',
      freeMarginal: false,
      marginalCostUsd: null,
      reason: 'No model calls recorded — nothing to cost.',
    };
  }
  if (anyCloud) {
    return {
      ...base,
      locality: 'cloud',
      freeMarginal: false,
      marginalCostUsd: null,
      reason: `${cloudCalls} of ${calls} call(s) used a cloud model — billed per token by the provider; price not tracked locally.`,
    };
  }
  if (anyUnknown) {
    return {
      ...base,
      locality: 'unknown',
      freeMarginal: false,
      marginalCostUsd: null,
      reason: 'Locality unproven for some call(s) — not claiming $0 without proof.',
    };
  }
  return {
    ...base,
    locality: 'local',
    freeMarginal: true,
    marginalCostUsd: 0,
    reason: `100% local — $0 marginal cost across ${calls} call(s); nothing left your machine.`,
  };
}
