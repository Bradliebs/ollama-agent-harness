import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Node types ─────────────────────────────────────────────────────

export type MyceliumNodeType = 'query' | 'memory' | 'tool' | 'skill' | 'agent' | 'strategy' | 'document' | 'output';

export interface MyceliumNode {
  id: string;
  type: MyceliumNodeType;
  label: string;
  trust: number;       // 0–1, how reliable this node has been
  cost: number;        // 0–1, how expensive to use
  activation: number;  // transient: current activation level
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
}

// ─── Episode (route history) ────────────────────────────────────────

export interface MyceliumEpisode {
  id: string;
  query: string;
  route: string[];        // ordered node IDs used
  reward: number;
  timestamp: string;
}

// ─── Graph ──────────────────────────────────────────────────────────

export interface MyceliumGraphData {
  nodes: MyceliumNode[];
  edges: MyceliumEdge[];
  episodes: MyceliumEpisode[];
}

const EMPTY_GRAPH: MyceliumGraphData = { nodes: [], edges: [], episodes: [] };

export class MyceliumGraph {
  private nodes = new Map<string, MyceliumNode>();
  private edges: MyceliumEdge[] = [];
  private episodes: MyceliumEpisode[] = [];

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

  addEdge(source: string, target: string, weight = 0.5): MyceliumEdge {
    const existing = this.getEdge(source, target);
    if (existing) { existing.weight = Math.max(existing.weight, weight); return existing; }
    const edge: MyceliumEdge = {
      source, target, weight,
      successCount: 0, failureCount: 0, totalReward: 0,
      lastUsed: new Date().toISOString(),
      protected: false,
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

  // ─── Episode operations ───────────────────────────────────

  recordEpisode(query: string, route: string[], reward: number): MyceliumEpisode {
    const episode: MyceliumEpisode = {
      id: crypto.randomUUID(),
      query,
      route,
      reward,
      timestamp: new Date().toISOString(),
    };
    this.episodes.push(episode);
    if (this.episodes.length > 500) this.episodes = this.episodes.slice(-500);
    return episode;
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
    };
  }

  static fromJSON(data: MyceliumGraphData): MyceliumGraph {
    const graph = new MyceliumGraph();
    for (const node of data.nodes ?? []) graph.nodes.set(node.id, { ...node, activation: 0 });
    graph.edges = [...(data.edges ?? [])];
    graph.episodes = [...(data.episodes ?? [])];
    return graph;
  }

  // ─── Stats ────────────────────────────────────────────────

  stats(): { nodes: number; edges: number; episodes: number; avgWeight: number } {
    const avgWeight = this.edges.length > 0
      ? this.edges.reduce((sum, e) => sum + e.weight, 0) / this.edges.length
      : 0;
    return { nodes: this.nodes.size, edges: this.edges.length, episodes: this.episodes.length, avgWeight: Math.round(avgWeight * 1000) / 1000 };
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
