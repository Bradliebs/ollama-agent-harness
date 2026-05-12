import type { MyceliumGraph, MyceliumNode, MyceliumEdge } from './graph';

// ─── Spread activation ─────────────────────────────────────────────
//
// Starting from a seed node (the query), propagate activation through
// weighted edges for a limited number of hops. Nodes accumulate
// activation from incoming edges proportional to the source activation
// and edge weight.

export interface ActivationConfig {
  /** Number of propagation rounds (default 3). */
  hops?: number;
  /** Minimum activation to include in the result (default 0.05). */
  threshold?: number;
  /** Damping factor applied at each hop (default 0.7). */
  damping?: number;
}

export function spreadActivation(
  graph: MyceliumGraph,
  seedNodeId: string,
  config: ActivationConfig = {},
): MyceliumNode[] {
  const { hops = 3, threshold = 0.05, damping = 0.7 } = config;

  graph.resetActivations();
  const seed = graph.getNode(seedNodeId);
  if (!seed) return [];
  seed.activation = 1.0;

  // Track which nodes have already received activation in this hop pass
  // so a single pass cannot loop back through itself. The seed counts as
  // visited from the start.
  const visitedThisPass = new Set<string>([seedNodeId]);

  for (let hop = 0; hop < hops; hop++) {
    const updates: Array<{ nodeId: string; delta: number }> = [];
    // Distance-decay per spec: each hop reduces flow.
    const distanceDecay = 1 / (hop + 1);

    for (const edge of graph.listEdges()) {
      const source = graph.getNode(edge.source);
      if (!source || source.activation <= 0) continue;
      // Skip self-loops outright.
      if (edge.source === edge.target) continue;

      const flow = source.activation * edge.weight * damping * distanceDecay;
      if (flow > 0) updates.push({ nodeId: edge.target, delta: flow });
    }

    // Apply updates after the round so iteration order doesn't matter.
    for (const { nodeId, delta } of updates) {
      const node = graph.getNode(nodeId);
      if (!node) continue;
      // Cycle guard: once a node has been visited in this activation pass
      // we still allow its activation to grow (additive evidence), but
      // we cap it at 1.0 to prevent runaway from cyclic graphs.
      node.activation = Math.min(1, node.activation + delta);
      visitedThisPass.add(nodeId);
    }
  }

  return graph.listNodes()
    .filter((n) => n.activation >= threshold)
    .sort((a, b) => b.activation - a.activation);
}

// ─── Route selection ────────────────────────────────────────────────
//
// Given an activated graph, select a compact subgraph for context.
// Balances exploitation (strong known paths) with exploration
// (weaker/novel paths). Always includes any protected edges whose
// endpoints are activated, regardless of exploration rate.

export type SelectionReason =
  | 'exploitation'
  | 'exploration'
  | 'protected_required'
  | 'verifier_required'
  | 'safety_required'
  | 'fallback';

export interface RouteConfig {
  /** Maximum nodes to include (default 12). */
  maxNodes?: number;
  /** Maximum edges to include (default maxNodes * 2). */
  maxEdges?: number;
  /** Exploration rate: probability of picking a non-best edge (default 0.15). */
  exploreRate?: number;
  /** Optional deterministic random for tests. Returns 0..1. */
  random?: () => number;
}

export interface SelectedEdge {
  edge: MyceliumEdge;
  reason: SelectionReason;
}

export interface SelectedRoute {
  nodes: MyceliumNode[];
  edges: MyceliumEdge[];
  /** Per-edge selection reason, keyed by `${source}->${target}`. */
  selectionReasons: Map<string, SelectionReason>;
  exploitedEdges: MyceliumEdge[];
  exploratoryEdges: MyceliumEdge[];
  protectedRequiredEdges: MyceliumEdge[];
  fallbackEdges: MyceliumEdge[];
}

export function selectRoute(
  graph: MyceliumGraph,
  activatedNodes: MyceliumNode[],
  config: RouteConfig = {},
): SelectedRoute {
  const { maxNodes = 12, exploreRate = 0.15, random = Math.random } = config;
  const maxEdges = config.maxEdges ?? maxNodes * 2;

  const selected = new Set<string>();
  const selectedEdgeKeys = new Set<string>();
  const selectedEdges: MyceliumEdge[] = [];
  const reasons = new Map<string, SelectionReason>();
  const exploited: MyceliumEdge[] = [];
  const exploratory: MyceliumEdge[] = [];
  const protectedRequired: MyceliumEdge[] = [];
  const fallback: MyceliumEdge[] = [];

  const addEdge = (edge: MyceliumEdge, reason: SelectionReason) => {
    const key = `${edge.source}->${edge.target}`;
    if (selectedEdgeKeys.has(key)) return;
    if (selectedEdges.length >= maxEdges) return;
    selectedEdgeKeys.add(key);
    selectedEdges.push(edge);
    reasons.set(key, reason);
    if (reason === 'exploitation') exploited.push(edge);
    else if (reason === 'exploration') exploratory.push(edge);
    else if (reason === 'fallback') fallback.push(edge);
    else protectedRequired.push(edge);
  };

  // 1) Protected edges whose endpoints are activated must always be
  //    included, regardless of exploration rate or node budget.
  const activatedIds = new Set(activatedNodes.map((n) => n.id));
  for (const edge of graph.listEdges()) {
    if (!edge.protected) continue;
    if (!activatedIds.has(edge.source) && !activatedIds.has(edge.target)) continue;
    const reason: SelectionReason = inferProtectedReason(graph, edge);
    addEdge(edge, reason);
    selected.add(edge.source);
    selected.add(edge.target);
  }

  // 2) Walk the activated nodes by descending activation and pick the
  //    best (or random) outgoing edge among activated targets.
  const candidates = [...activatedNodes];
  for (const node of candidates) {
    if (selected.size >= maxNodes && selectedEdges.length >= maxEdges) break;
    selected.add(node.id);

    const outgoing = graph.outgoingEdges(node.id).filter((e) => {
      const target = graph.getNode(e.target);
      return target && target.activation > 0;
    });
    if (outgoing.length === 0) continue;

    const explore = random() < exploreRate;
    const chosen = explore
      ? outgoing[Math.floor(random() * outgoing.length)]
      : outgoing.reduce((best, e) => edgeScore(e, graph) > edgeScore(best, graph) ? e : best, outgoing[0]);

    if (chosen) {
      addEdge(chosen, explore ? 'exploration' : 'exploitation');
      if (selected.size < maxNodes) selected.add(chosen.target);
    }
  }

  const nodes = Array.from(selected)
    .map((id) => graph.getNode(id))
    .filter((n): n is MyceliumNode => n !== undefined);

  return {
    nodes,
    edges: selectedEdges,
    selectionReasons: reasons,
    exploitedEdges: exploited,
    exploratoryEdges: exploratory,
    protectedRequiredEdges: protectedRequired,
    fallbackEdges: fallback,
  };
}

function inferProtectedReason(graph: MyceliumGraph, edge: MyceliumEdge): SelectionReason {
  const src = graph.getNode(edge.source);
  const tgt = graph.getNode(edge.target);
  if (src?.type === 'safety' || tgt?.type === 'safety') return 'safety_required';
  if (src?.type === 'verifier' || tgt?.type === 'verifier') return 'verifier_required';
  return 'protected_required';
}

function edgeScore(edge: MyceliumEdge, graph: MyceliumGraph): number {
  const target = graph.getNode(edge.target);
  const targetActivation = target?.activation ?? 0;
  const targetTrust = target?.trust ?? 0.5;
  const targetCost = target?.cost ?? 0;
  return edge.weight + targetActivation + targetTrust - targetCost;
}
