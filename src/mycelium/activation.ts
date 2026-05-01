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

  for (let hop = 0; hop < hops; hop++) {
    const updates: Array<{ nodeId: string; delta: number }> = [];

    for (const edge of graph.listEdges()) {
      const source = graph.getNode(edge.source);
      if (!source || source.activation <= 0) continue;

      const flow = source.activation * edge.weight * damping;
      if (flow > 0) updates.push({ nodeId: edge.target, delta: flow });
    }

    for (const { nodeId, delta } of updates) {
      const node = graph.getNode(nodeId);
      if (node) node.activation = Math.min(1, node.activation + delta);
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
// (weaker/novel paths).

export interface RouteConfig {
  /** Maximum nodes to include (default 12). */
  maxNodes?: number;
  /** Exploration rate: probability of picking a random edge (default 0.15). */
  exploreRate?: number;
}

export interface SelectedRoute {
  nodes: MyceliumNode[];
  edges: MyceliumEdge[];
}

export function selectRoute(
  graph: MyceliumGraph,
  activatedNodes: MyceliumNode[],
  config: RouteConfig = {},
): SelectedRoute {
  const { maxNodes = 12, exploreRate = 0.15 } = config;

  const selected = new Set<string>();
  const selectedEdges: MyceliumEdge[] = [];

  // Always include the highest-activation nodes up to the limit
  const candidates = [...activatedNodes];

  for (const node of candidates) {
    if (selected.size >= maxNodes) break;
    selected.add(node.id);

    // Select outgoing edges
    const outgoing = graph.outgoingEdges(node.id).filter((e) => {
      const target = graph.getNode(e.target);
      return target && target.activation > 0;
    });

    if (outgoing.length === 0) continue;

    // Exploration vs exploitation
    const explore = Math.random() < exploreRate;
    const chosen = explore
      ? outgoing[Math.floor(Math.random() * outgoing.length)]
      : outgoing.reduce((best, e) => edgeScore(e, graph) > edgeScore(best, graph) ? e : best, outgoing[0]);

    if (chosen) {
      selectedEdges.push(chosen);
      selected.add(chosen.target);
    }
  }

  const nodes = Array.from(selected)
    .map((id) => graph.getNode(id))
    .filter((n): n is MyceliumNode => n !== undefined);

  return { nodes, edges: selectedEdges };
}

function edgeScore(edge: MyceliumEdge, graph: MyceliumGraph): number {
  const target = graph.getNode(edge.target);
  const targetActivation = target?.activation ?? 0;
  const targetTrust = target?.trust ?? 0.5;
  const targetCost = target?.cost ?? 0;
  return edge.weight + targetActivation + targetTrust - targetCost;
}
