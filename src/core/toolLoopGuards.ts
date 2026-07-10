/**
 * Tool-loop guardrails (Hermes-borrowed B5).
 *
 * Pure-functional detection of two pathological loops the model can fall into
 * even when individual tool calls SUCCEED:
 *
 *   1. Consecutive-same-call: model invokes the same tool with the same
 *      arguments N turns in a row (e.g. read_file(foo.ts) five times). The
 *      existing `repeatedToolFailureLimit` guard only fires on FAILURE, so
 *      successful-but-redundant loops slip through.
 *
 *   2. Duplicate-result: a tool returns byte-identical output two turns in
 *      a row for the same (name, args). Often a sign the model is stuck in
 *      a confirmation loop and not advancing.
 *
 * Both detectors are pure; queryLoop owns the state map and decides whether
 * to inject a nudge / yield a tracer event. Default-OFF behind
 * `HARNESS_LOOP_HARDENING` — these helpers do not read env themselves.
 */

import type { ToolCall } from '../types';

/**
 * Stable JSON serialization of a tool call's arguments. Sorts object keys
 * recursively so `{a:1,b:2}` and `{b:2,a:1}` produce the same key. Used
 * only to fingerprint same-args calls for the consecutive-same-call guard;
 * NOT a security boundary (the args themselves still flow through unchanged).
 */
export function stableArgsKey(input: Record<string, unknown> | undefined): string {
  if (!input) return '{}';
  return JSON.stringify(sortKeys(input));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = sortKeys(obj[k]);
  return sorted;
}

export interface ConsecutiveCallTracker {
  lastKey: string | null;
  count: number;
}

/**
 * Update the consecutive-same-call tracker against a new ToolCall.
 *
 * Returns the new count for `(name, argsKey)`. Caller compares against
 * its threshold and reacts. The tracker is mutated in place; call sites
 * should `createConsecutiveCallTracker()` once per loop run.
 */
export function trackConsecutiveCall(tracker: ConsecutiveCallTracker, call: ToolCall): number {
  const key = `${call.name}:${stableArgsKey(call.input)}`;
  if (tracker.lastKey === key) {
    tracker.count += 1;
  } else {
    tracker.lastKey = key;
    tracker.count = 1;
  }
  return tracker.count;
}

export function createConsecutiveCallTracker(): ConsecutiveCallTracker {
  return { lastKey: null, count: 0 };
}

export function resetConsecutiveCallTracker(tracker: ConsecutiveCallTracker): void {
  tracker.lastKey = null;
  tracker.count = 0;
}

export interface DuplicateResultTracker {
  /** Map (name + argsKey) -> last seen result output. */
  lastByKey: Map<string, string>;
  /** Map (name + argsKey) -> count of consecutive identical outputs. */
  countByKey: Map<string, number>;
}

export function createDuplicateResultTracker(): DuplicateResultTracker {
  return { lastByKey: new Map(), countByKey: new Map() };
}

/**
 * Update the duplicate-result tracker. Returns the new consecutive-identical
 * count for the (name, args) key. A return of 1 means "first time we've seen
 * this output for these args"; 2 means "same output twice in a row". Caller
 * compares against threshold and reacts.
 */
export function trackResult(
  tracker: DuplicateResultTracker,
  call: ToolCall,
  output: string,
): number {
  const key = `${call.name}:${stableArgsKey(call.input)}`;
  const prior = tracker.lastByKey.get(key);
  if (prior !== undefined && prior === output) {
    const next = (tracker.countByKey.get(key) ?? 1) + 1;
    tracker.countByKey.set(key, next);
    return next;
  }
  tracker.lastByKey.set(key, output);
  tracker.countByKey.set(key, 1);
  return 1;
}

/** Default thresholds. Tuned to match Hermes-borrowed defaults. */
export const DEFAULT_CONSECUTIVE_CALL_LIMIT = 3;
export const DEFAULT_DUPLICATE_RESULT_LIMIT = 2;

/**
 * Build the model-facing nudge text for a triggered consecutive-call guard.
 * Phrased as a user-role observation so providers that reject system-after-tool
 * (Mistral, Anthropic) accept it — same convention as the existing
 * `repeatedToolFailureLimit` warning.
 */
export function buildConsecutiveCallNudge(
  call: ToolCall,
  count: number,
): string {
  return `⚠️ You have called ${call.name} with the same arguments ${count} times in a row. The repeated call is unlikely to produce new information. Either use a different tool, vary the arguments, or proceed to synthesis with what you already have.`;
}

/**
 * Build the model-facing nudge text for a triggered duplicate-result guard.
 */
export function buildDuplicateResultNudge(
  call: ToolCall,
  count: number,
): string {
  return `⚠️ ${call.name} has returned identical output ${count} times in a row for the same arguments. The result is stable; do not call it again with these arguments. Choose a different action.`;
}
