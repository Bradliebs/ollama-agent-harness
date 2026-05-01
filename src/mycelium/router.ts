import { MyceliumGraph, loadMyceliumGraph, saveMyceliumGraph, type MyceliumNode, type MyceliumNodeType } from './graph';
import { spreadActivation, selectRoute, type SelectedRoute } from './activation';
import { reinforceRoute, weakenRoute, decayUnusedEdges, pruneDeadEdges, computeReward, type RewardInput } from './reinforcement';
import { logger } from '../core/logger';

// ─── Router configuration ───────────────────────────────────────────

export interface MycelialRouterConfig {
  /** Reinforcement learning rate (default 0.08). */
  alpha?: number;
  /** Decay rate for unused edges (default 0.02). */
  beta?: number;
  /** Exploration rate for route selection (default 0.15). */
  exploreRate?: number;
  /** Maximum context nodes per query (default 12). */
  maxNodes?: number;
  /** Activation propagation hops (default 3). */
  hops?: number;
}

// ─── Context result ─────────────────────────────────────────────────

export interface MycelialContextResult {
  /** Selected nodes that form the context subgraph. */
  nodes: MyceliumNode[];
  /** Node IDs in route order. */
  route: string[];
  /** Context text assembled from selected nodes. */
  contextText: string;
  /** Graph stats after routing. */
  stats: ReturnType<MyceliumGraph['stats']>;
}

// ─── Router ─────────────────────────────────────────────────────────

export class MycelialContextRouter {
  private graph: MyceliumGraph;
  private projectDir: string;
  private config: Required<MycelialRouterConfig>;
  private lastRoute: string[] = [];

  constructor(projectDir: string, graph: MyceliumGraph, config: MycelialRouterConfig = {}) {
    this.projectDir = projectDir;
    this.graph = graph;
    this.config = {
      alpha: config.alpha ?? 0.08,
      beta: config.beta ?? 0.02,
      exploreRate: config.exploreRate ?? 0.15,
      maxNodes: config.maxNodes ?? 12,
      hops: config.hops ?? 3,
    };
  }

  // ─── Seed the graph with system components ──────────────────

  seedToolNodes(tools: Array<{ name: string; description: string; riskLevel?: string }>): void {
    for (const tool of tools) {
      const id = `tool.${tool.name}`;
      if (!this.graph.getNode(id)) {
        this.graph.addNode({
          id,
          type: 'tool',
          label: tool.name,
          trust: tool.riskLevel === 'high' ? 0.4 : tool.riskLevel === 'medium' ? 0.6 : 0.8,
          cost: tool.riskLevel === 'high' ? 0.7 : tool.riskLevel === 'medium' ? 0.4 : 0.1,
        });
      }
    }
  }

  seedSkillNodes(skills: Array<{ name: string; description: string; domain?: string }>): void {
    for (const skill of skills) {
      const id = `skill.${skill.name}`;
      if (!this.graph.getNode(id)) {
        this.graph.addNode({
          id,
          type: 'skill',
          label: skill.name,
          trust: 0.6,
          cost: 0.2,
          metadata: { description: skill.description, domain: skill.domain },
        });
      }
    }
  }

  seedMemoryNodes(entries: Array<{ id: string; text: string; kind?: string }>): void {
    for (const entry of entries) {
      const id = `memory.${entry.id}`;
      if (!this.graph.getNode(id)) {
        this.graph.addNode({
          id,
          type: 'memory',
          label: entry.text.slice(0, 80),
          trust: 0.7,
          cost: 0.05,
          metadata: { kind: entry.kind },
        });
      }
    }
  }

  seedStrategyNode(id: string, label: string, trust = 0.5): void {
    const nodeId = `strategy.${id}`;
    if (!this.graph.getNode(nodeId)) {
      this.graph.addNode({ id: nodeId, type: 'strategy', label, trust, cost: 0.1 });
    }
  }

  // ─── Route a query ────────────────────────────────────────

  routeQuery(query: string, relevanceScores?: Map<string, number>): MycelialContextResult {
    // Step A: Create temporary query node
    const queryId = 'query.current';
    this.graph.removeNode(queryId);
    const queryNode = this.graph.addNode({
      id: queryId,
      type: 'query',
      label: query.slice(0, 120),
      trust: 1,
      cost: 0,
    });

    // Step B: Connect query to candidate nodes based on relevance
    const allNodes = this.graph.listNodes().filter((n) => n.type !== 'query');
    for (const node of allNodes) {
      const relevance = relevanceScores?.get(node.id) ?? estimateRelevance(query, node);
      if (relevance > 0.1) {
        this.graph.addEdge(queryId, node.id, relevance);
      }
    }

    // Step C: Spread activation
    const activated = spreadActivation(this.graph, queryId, {
      hops: this.config.hops,
      threshold: 0.05,
    });

    // Step D: Select route
    const route = selectRoute(this.graph, activated, {
      maxNodes: this.config.maxNodes,
      exploreRate: this.config.exploreRate,
    });

    // Step E: Collect context
    const contextParts = route.nodes
      .filter((n) => n.type !== 'query')
      .map((n) => `[${n.type}:${n.label}] (trust:${n.trust.toFixed(2)} activation:${n.activation.toFixed(2)})`);

    this.lastRoute = route.nodes.map((n) => n.id);

    // Clean up temporary query node
    this.graph.removeNode(queryId);

    logger.info('Mycelium', 'Route selected', {
      activated: activated.length,
      selected: route.nodes.length,
      edges: route.edges.length,
    });

    return {
      nodes: route.nodes.filter((n) => n.type !== 'query'),
      route: this.lastRoute.filter((id) => id !== queryId),
      contextText: contextParts.join('\n'),
      stats: this.graph.stats(),
    };
  }

  // ─── Reinforce after response ─────────────────────────────

  reinforce(reward: RewardInput): void {
    if (this.lastRoute.length === 0) return;
    const score = computeReward(reward);
    if (score > 0.3) {
      reinforceRoute(this.graph, this.lastRoute, score, { alpha: this.config.alpha });
    } else {
      weakenRoute(this.graph, this.lastRoute, 1 - score, { alpha: this.config.alpha });
    }
  }

  // ─── Maintenance ──────────────────────────────────────────

  decay(): { decayed: number; pruned: number } {
    const decayed = decayUnusedEdges(this.graph, { beta: this.config.beta });
    const pruned = pruneDeadEdges(this.graph);
    return { decayed, pruned };
  }

  // ─── Persistence ──────────────────────────────────────────

  async save(): Promise<void> {
    await saveMyceliumGraph(this.projectDir, this.graph);
  }

  getGraph(): MyceliumGraph {
    return this.graph;
  }

  getLastRoute(): string[] {
    return [...this.lastRoute];
  }

  stats(): ReturnType<MyceliumGraph['stats']> {
    return this.graph.stats();
  }
}

// ─── Load router from disk ──────────────────────────────────────────

export async function createMycelialRouter(projectDir: string, config?: MycelialRouterConfig): Promise<MycelialContextRouter> {
  const graph = await loadMyceliumGraph(projectDir);
  return new MycelialContextRouter(projectDir, graph, config);
}

// ─── Simple keyword-based relevance (no embeddings needed) ──────────

function estimateRelevance(query: string, node: MyceliumNode): number {
  const queryLower = query.toLowerCase();
  const labelLower = node.label.toLowerCase();

  // Check for word overlap
  const queryWords = new Set(queryLower.split(/\s+/).filter((w) => w.length > 2));
  const labelWords = labelLower.split(/\s+/).filter((w) => w.length > 2);

  if (queryWords.size === 0 || labelWords.length === 0) return 0.1;

  const matches = labelWords.filter((w) => queryWords.has(w)).length;
  const overlap = matches / Math.max(queryWords.size, labelWords.length);

  // Check metadata description
  const desc = String(node.metadata?.description ?? '').toLowerCase();
  const descWords = desc.split(/\s+/).filter((w) => w.length > 2);
  const descMatches = descWords.filter((w) => queryWords.has(w)).length;
  const descOverlap = descWords.length > 0 ? descMatches / queryWords.size : 0;

  // Combine with base relevance from trust
  return Math.min(1, overlap * 0.6 + descOverlap * 0.3 + node.trust * 0.1);
}
