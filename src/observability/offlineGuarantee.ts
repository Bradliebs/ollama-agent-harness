// Offline guarantee — honest, evidence-earned "is this run provably local?".
//
// The product claims to be local-first. A badge that says "offline" must be
// earned, not assumed: the same "no claim without proof" discipline used by
// the cost and provenance signals. A run is reported `offline` ONLY when the
// model provably ran locally AND no network-category tool was used. Any cloud
// model or any network tool is positive proof of `online`. If the model
// locality is unrecorded, or a tool's category cannot be resolved, the verdict
// is `unknown` — we never paint an "offline" badge we cannot back up.
//
// Network tools count regardless of success: a failed web_fetch still attempts
// DNS/socket work, so it breaks the offline guarantee just as a successful one
// does. Tool category is resolved by the caller (from the live tool registry,
// which includes runtime/MCP tools); this module stays pure and I/O-free.

import type { ModelLocality } from './costProvenance';
import type { ToolPermissionCategory } from '../types/tool';

export type OfflineState = 'offline' | 'online' | 'unknown';

export interface OfflineToolRef {
  name: string;
  /** Resolved permission category, or undefined when the tool is unknown. */
  category: ToolPermissionCategory | undefined;
}

export interface OfflineVerdict {
  state: OfflineState;
  /** Network-category tools that were used (deduped, first-seen order). */
  networkTools: string[];
  /** Used tools whose category could not be resolved (deduped). */
  unknownTools: string[];
  reason: string;
}

function uniqueNames(refs: OfflineToolRef[], match: (ref: OfflineToolRef) => boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (!match(ref)) continue;
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    out.push(ref.name);
  }
  return out;
}

export function assessOfflineGuarantee(input: {
  modelLocality: ModelLocality;
  tools: OfflineToolRef[];
}): OfflineVerdict {
  const { modelLocality, tools } = input;
  const networkTools = uniqueNames(tools, (t) => t.category === 'network');
  const unknownTools = uniqueNames(tools, (t) => t.category === undefined);

  let state: OfflineState;
  let reason: string;

  if (modelLocality === 'cloud' || networkTools.length > 0) {
    // Positive proof the run reached the network.
    const parts: string[] = [];
    if (modelLocality === 'cloud') parts.push('a cloud model was used');
    if (networkTools.length > 0) parts.push(`network tool(s): ${networkTools.join(', ')}`);
    state = 'online';
    reason = `Online: ${parts.join('; ')}.`;
  } else if (modelLocality === 'unknown' || unknownTools.length > 0) {
    // Cannot prove offline — safe default, no fabricated "offline" badge.
    const parts: string[] = [];
    if (modelLocality === 'unknown') parts.push('model locality not recorded');
    if (unknownTools.length > 0) parts.push(`unverified tool(s): ${unknownTools.join(', ')}`);
    state = 'unknown';
    reason = `Offline unconfirmed: ${parts.join('; ')}.`;
  } else {
    // Model provably local and every tool is a known non-network category.
    state = 'offline';
    reason = 'Offline: model ran locally and no network tools were used.';
  }

  return { state, networkTools, unknownTools, reason };
}
