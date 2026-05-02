import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Node types ─────────────────────────────────────────────────────

export type MyceliumNodeType =
  | 'query'
  | 'memory'
  | 'tool'
  | 'skill'
  | 'agent'
  | 'strategy'
  | 'document'
  | 'output'
  | 'safety'
  | 'verifier'
  | 'prompt_template'
  | 'workflow'
  | 'constraint'
  | 'preference';

export interface MyceliumNode {
  id: string;
  type: MyceliumNodeType;
  label: string;
  trust: number;       // 0–1, how reliable this node has been
  cost: number;        // 0–1, how expensive to use
  activation: number;  // transient: current activation level
  /** Protected nodes (safety, verifiers, user prefs) are never pruned. */
  protected?: boolean;
  /** Optional human-readable summary used when building context packages. */
  summary?: string;
  metadata?: Record<string, unknown>;
}

// ─── Edge types ─────────────────────────────────────────────────────

export interface MyceliumEdge {
  source: string;
  target: string;
  weight: number;         // 0–1, current strength
  successCount: number;
  failureCount: number;
  totalReward: number;
  lastUsed: string;       // ISO timestamp
  protected: boolean;     // if true, never pruned
  /** Optional relation type, e.g. 'routes_to', 'must_verify_with', 'sequence_learning'. */
  relation?: string;
  /** Where this edge came from: seeded, query, sequence, manual. */
  origin?: 'seeded' | 'query' | 'sequence' | 'manual' | 'reinforcement';
  /** Times this edge was part of a route that hit a hard verifier block. */
  blockedCount?: number;
  /** ISO timestamp of the most recent hard block on this route. */
  lastBlockedAt?: string;
}

// ─── Episode (route history) ────────────────────────────────────────

export interface MyceliumEpisode {
  id: string;
  query: string;
  route: string[];        // ordered node IDs used
  reward: number;
  timestamp: string;  /** Optional route metadata for inspection. */
  taskType?: string;
  selectionReasons?: Record<string, string>;
  rewardComponents?: Record<string, number>;
  dryRun?: boolean;
  /** True when a verifier hard-check failed during this run. */
  blocked?: boolean;
  /** Human-readable reason the run was blocked, e.g. 'output_validation:fail'. */
  blockReason?: string;
  /** Names of verifier nodes that conceptually applied to this run. */
  appliedVerifiers?: string[];
  /** Explicit user feedback that drove this episode's reward, if any. */
  userFeedback?: 'up' | 'down' | 'neutral';
}

// ─── Archived edge (soft-deleted) ─────────────────────────

export interface ArchivedEdge {
  edge: MyceliumEdge;
  reason: string;
  archivedAt: string;}

// ─── Graph ──────────────────────────────────────────────────────────

export interface MyceliumGraphData {
  nodes: MyceliumNode[];
  edges: MyceliumEdge[];
  episodes: MyceliumEpisode[];
  archivedEdges?: ArchivedEdge[];
}

const EMPTY_GRAPH: MyceliumGraphData = { nodes: [], edges: [], episodes: [], archivedEdges: [] };

export class MyceliumGraph {
  private nodes = new Map<string, MyceliumNode>();
  private edges: MyceliumEdge[] = [];
  private episodes: MyceliumEpisode[] = [];
  private archivedEdges: ArchivedEdge[] = [];

  // ─── Node operations ──────────────────────────────────────

  addNode(node: Omit<MyceliumNode, 'activation'>): MyceliumNode {
    const full: MyceliumNode = { ...node, activation: 0 };
    this.nodes.set(full.id, full);
    return full;
  }

  getNode(id: string): MyceliumNode | undefined {
    return this.nodes.get(id);
  }

  listNodes(type?: MyceliumNodeType): MyceliumNode[] {
    const all = Array.from(this.nodes.values());
    return type ? all.filter((n) => n.type === type) : all;
  }

  removeNode(id: string): boolean {
    if (!this.nodes.delete(id)) return false;
    this.edges = this.edges.filter((e) => e.source !== id && e.target !== id);
    return true;
  }

  // ─── Edge operations ──────────────────────────────────────

  addEdge(source: string, target: string, weight = 0.5, options?: { relation?: string; origin?: MyceliumEdge['origin'] }): MyceliumEdge {
    const existing = this.getEdge(source, target);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      // Preserve the first-known origin/relation; only fill if missing.
      if (options?.relation && !existing.relation) existing.relation = options.relation;
      if (options?.origin && !existing.origin) existing.origin = options.origin;
      return existing;
    }
    const edge: MyceliumEdge = {
      source, target, weight,
      successCount: 0, failureCount: 0, totalReward: 0,
      lastUsed: new Date().toISOString(),
      protected: false,
      relation: options?.relation,
      origin: options?.origin,
    };
    this.edges.push(edge);
    return edge;
  }

  getEdge(source: string, target: string): MyceliumEdge | undefined {
    return this.edges.find((e) => e.source === source && e.target === target);
  }

  outgoingEdges(nodeId: string): MyceliumEdge[] {
    return this.edges.filter((e) => e.source === nodeId);
  }

  incomingEdges(nodeId: string): MyceliumEdge[] {
    return this.edges.filter((e) => e.target === nodeId);
  }

  listEdges(): MyceliumEdge[] {
    return [...this.edges];
  }

  filterEdges(predicate: (edge: MyceliumEdge) => boolean): number {
    const before = this.edges.length;
    this.edges = this.edges.filter(predicate);
    return before - this.edges.length;
  }

  // ─── Archive operations ─────────────────────────────────

  /**
   * Archive an edge instead of hard-deleting. Returns true if the edge
   * was found and archived. Protected edges are never archived.
   */
  archiveEdge(source: string, target: string, reason: string): boolean {
    const edge = this.getEdge(source, target);
    if (!edge || edge.protected) return false;
    this.archivedEdges.push({
      edge: { ...edge },
      reason,
      archivedAt: new Date().toISOString(),
    });
    this.edges = this.edges.filter((e) => !(e.source === source && e.target === target));
    return true;
  }

  listArchivedEdges(): ArchivedEdge[] {
    return [...this.archivedEdges];
  }

  /** Protected nodes can be queried separately for inspection. */
  listProtectedNodes(): MyceliumNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.protected);
  }

  /** Protected edges can be queried separately for inspection. */
  listProtectedEdges(): MyceliumEdge[] {
    return this.edges.filter((e) => e.protected);
  }

  // ─── Episode operations ───────────────────────────────────

  recordEpisode(query: string, route: string[], reward: number, extras?: {
    taskType?: string;
    selectionReasons?: Record<string, string>;
    rewardComponents?: Record<string, number>;
    dryRun?: boolean;
    blocked?: boolean;
    blockReason?: string;
    appliedVerifiers?: string[];
  }): MyceliumEpisode {
    const episode: MyceliumEpisode = {
      id: crypto.randomUUID(),
      query,
      route,
      reward,
      timestamp: new Date().toISOString(),
      ...(extras ?? {}),
    };
    this.episodes.push(episode);
    if (this.episodes.length > 500) this.episodes = this.episodes.slice(-500);
    return episode;
  }

  /**
   * Mark every edge along `route` as having participated in a blocked
   * (hard-failed) run. Bumps `blockedCount` and `lastBlockedAt`. Used by
   * the router after a verifier hard-check failure so the UI can surface
   * which routes have repeatedly tripped safety blocks.
   */
  markRouteBlocked(route: string[]): number {
    let touched = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < route.length - 1; i++) {
      const edge = this.getEdge(route[i], route[i + 1]);
      if (!edge) continue;
      edge.blockedCount = (edge.blockedCount ?? 0) + 1;
      edge.lastBlockedAt = now;
      touched++;
    }
    return touched;
  }

  listEpisodes(limit = 50): MyceliumEpisode[] {
    return this.episodes.slice(-limit);
  }

  // ─── Activation ───────────────────────────────────────────

  resetActivations(): void {
    for (const node of this.nodes.values()) node.activation = 0;
  }

  // ─── Serialization ────────────────────────────────────────

  toJSON(): MyceliumGraphData {
    return {
      nodes: Array.from(this.nodes.values()).map((n) => ({ ...n, activation: 0 })),
      edges: [...this.edges],
      episodes: [...this.episodes],
      archivedEdges: [...this.archivedEdges],
    };
  }

  static fromJSON(data: MyceliumGraphData): MyceliumGraph {
    const graph = new MyceliumGraph();
    for (const node of data.nodes ?? []) graph.nodes.set(node.id, { ...node, activation: 0 });
    graph.edges = [...(data.edges ?? [])];
    graph.episodes = [...(data.episodes ?? [])];
    graph.archivedEdges = [...(data.archivedEdges ?? [])];
    return graph;
  }

  // ─── Stats ────────────────────────────────────────────────

  stats(): { nodes: number; edges: number; episodes: number; avgWeight: number; protectedNodes: number; protectedEdges: number; archivedEdges: number } {
    const avgWeight = this.edges.length > 0
      ? this.edges.reduce((sum, e) => sum + e.weight, 0) / this.edges.length
      : 0;
    let protectedNodes = 0;
    for (const n of this.nodes.values()) if (n.protected) protectedNodes++;
    const protectedEdges = this.edges.filter((e) => e.protected).length;
    return {
      nodes: this.nodes.size,
      edges: this.edges.length,
      episodes: this.episodes.length,
      avgWeight: Math.round(avgWeight * 1000) / 1000,
      protectedNodes,
      protectedEdges,
      archivedEdges: this.archivedEdges.length,
    };
  }
}

// ─── Persistence ──────────────────────────────────────────────────

export async function loadMyceliumGraph(projectDir: string): Promise<MyceliumGraph> {
  try {
    const raw = await fs.readFile(graphPath(projectDir), 'utf-8');
    return MyceliumGraph.fromJSON(JSON.parse(raw) as MyceliumGraphData);
  } catch {
    return new MyceliumGraph();
  }
}

export async function saveMyceliumGraph(projectDir: string, graph: MyceliumGraph): Promise<void> {
  const filePath = graphPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(graph.toJSON(), null, 2), 'utf-8');
}

function graphPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'mycelium', 'graph.json');
}
