import { MyceliumGraph, type MyceliumNode, type MyceliumNodeType } from './graph';
import { getSharedMyceliumGraph, flushSharedMyceliumGraph, registerSharedMyceliumGraph } from './graphStore';
import { spreadActivation, selectRoute, type SelectedRoute } from './activation';
import { reinforceRoute, weakenRoute, decayUnusedEdges, pruneDeadEdges, computeReward, type RewardInput } from './reinforcement';
import { classifyTask, type MyceliumTaskClassification } from './taskClassifier';
import { seedGenericGraph, type SeedSummary } from './seeds';
import { buildContextPackage, buildRouteExplanation, formatRouteExplanation, type ContextPackage, type RouteExplanation } from './contextPackage';
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
// ─── Rich routing result (v2) ───────────────────────────────────

export interface RouteQueryOptions {
  /** If true, log the route but do not let the harness execute external actions. */
  dryRun?: boolean;
  /** Pre-computed semantic relevance scores for candidate nodes. */
  relevanceScores?: Map<string, number>;
  /** Override the rule-based classifier (e.g. for tests). */
  classification?: MyceliumTaskClassification;
  /** Override the random source for deterministic exploration in tests. */
  random?: () => number;
}

export interface MycelialRichResult extends MycelialContextResult {
  classification: MyceliumTaskClassification;
  contextPackage: ContextPackage;
  explanation: RouteExplanation;
  selectedRoute: SelectedRoute;
}
// ─── Router ─────────────────────────────────────────────────────────

export class MycelialContextRouter {
  private graph: MyceliumGraph;
  private projectDir: string;
  private config: Required<MycelialRouterConfig>;
  private lastRoute: string[] = [];
  private lastQuery: string = '';
  private lastDryRun: boolean = false;
  private lastSelectionReasons: Record<string, string> = {};
  private lastExplanation: RouteExplanation | null = null;
  private lastContextPackage: ContextPackage | null = null;
  private lastClassification: MyceliumTaskClassification | null = null;

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

  /** Seed the generic safety / agent / workflow / verifier / prompt nodes. Idempotent. */
  seedGeneric(): SeedSummary {
    return seedGenericGraph(this.graph);
  }

  // ─── Route a query ────────────────────────────────────────

  routeQuery(query: string, relevanceScores?: Map<string, number>): MycelialContextResult {
    const rich = this.routeQueryRich(query, { relevanceScores });
    return {
      nodes: rich.nodes,
      route: rich.route,
      contextText: rich.contextText,
      stats: rich.stats,
    };
  }

  /**
   * Route a query and return the rich result: classification, structured
   * context package, route explanation, and the SelectedRoute itself.
   * The legacy routeQuery() above delegates here.
   */
  routeQueryRich(query: string, options: RouteQueryOptions = {}): MycelialRichResult {
    const classification = options.classification ?? classifyTask(query);
    const dryRun = options.dryRun ?? false;

    // Step A: Create temporary query node
    const queryId = 'query.current';
    this.graph.removeNode(queryId);
    this.graph.addNode({
      id: queryId,
      type: 'query',
      label: query.slice(0, 120),
      trust: 1,
      cost: 0,
    });

    // Step B: Connect query to candidate nodes based on relevance
    const allNodes = this.graph.listNodes().filter((n) => n.type !== 'query');
    for (const node of allNodes) {
      const relevance = options.relevanceScores?.get(node.id) ?? estimateRelevance(query, node);
      if (relevance > 0.1) {
        this.graph.addEdge(queryId, node.id, relevance);
      }
    }

    // Step C: Spread activation (depth from classification, not config).
    const activated = spreadActivation(this.graph, queryId, {
      hops: classification.maxDepth,
      threshold: 0.05,
    });

    // Step D: Select route. Task-specific exploration / node limits;
    // high-risk tasks are clamped near zero exploration regardless of config.
    const exploreRate = classification.highRisk
      ? Math.min(this.config.exploreRate, classification.explorationRate)
      : classification.explorationRate;
    const route = selectRoute(this.graph, activated, {
      maxNodes: Math.min(this.config.maxNodes, classification.maxSelectedNodes),
      maxEdges: classification.maxSelectedEdges,
      exploreRate,
      random: options.random,
    });

    // Step E: Collect context
    const contextParts = route.nodes
      .filter((n) => n.type !== 'query')
      .map((n) => `[${n.type}:${n.label}] (trust:${n.trust.toFixed(2)} activation:${n.activation.toFixed(2)})`);

    this.lastRoute = route.nodes.map((n) => n.id);

    // Build structured outputs while the query node is still in the graph
    // so route metadata / IDs are consistent.
    const contextPackage = buildContextPackage({ query, classification, route, dryRun });
    const explanation = buildRouteExplanation({ classification, route, graph: this.graph });

    // Clean up temporary query node
    this.graph.removeNode(queryId);

    this.lastClassification = classification;
    this.lastContextPackage = contextPackage;
    this.lastExplanation = explanation;
    this.lastQuery = query;
    this.lastDryRun = dryRun;
    // Convert the per-edge selection reasons map into a plain object so it
    // serialises cleanly into episode metadata.
    this.lastSelectionReasons = Object.fromEntries(route.selectionReasons.entries());

    logger.info('Mycelium', 'Route selected', {
      taskType: classification.type,
      highRisk: classification.highRisk,
      activated: activated.length,
      selected: route.nodes.length,
      edges: route.edges.length,
      protectedRequired: route.protectedRequiredEdges.length,
      exploration: route.exploratoryEdges.length,
      dryRun,
    });

    return {
      nodes: route.nodes.filter((n) => n.type !== 'query'),
      route: this.lastRoute.filter((id) => id !== queryId),
      contextText: contextParts.join('\n'),
      stats: this.graph.stats(),
      classification,
      contextPackage,
      explanation,
      selectedRoute: route,
    };
  }

  // ─── Reinforce after response ─────────────────────────────

  reinforce(reward: RewardInput, verifierInfo?: { blocked?: boolean; blockReason?: string; appliedVerifiers?: string[] }): void {
    if (this.lastRoute.length === 0) return;
    const score = computeReward(reward);
    // Capture the reward components so episode metadata can show what
    // drove the final score (visible in the UI's "Last route" panel).
    const rewardComponents: Record<string, number> = {};
    for (const [k, v] of Object.entries(reward)) {
      if (typeof v === 'number') rewardComponents[k] = v;
    }
    rewardComponents.final = score;

    const blocked = verifierInfo?.blocked ?? false;
    const episodeExtras = {
      query: this.lastQuery,
      taskType: this.lastClassification?.type,
      selectionReasons: this.lastSelectionReasons,
      rewardComponents,
      dryRun: this.lastDryRun,
      blocked,
      blockReason: verifierInfo?.blockReason,
      appliedVerifiers: verifierInfo?.appliedVerifiers,
    };

    if (blocked) {
      // Hard verifier failures: bump per-edge blockedCount so the UI can
      // surface persistently risky routes. Do not reinforce; weaken instead.
      this.graph.markRouteBlocked(this.lastRoute);
      weakenRoute(this.graph, this.lastRoute, 1, { alpha: this.config.alpha });
      this.graph.recordEpisode(this.lastQuery, this.lastRoute, score, episodeExtras);
    } else if (score > 0.3) {
      reinforceRoute(this.graph, this.lastRoute, score, { alpha: this.config.alpha }, episodeExtras);
    } else {
      // Failed runs still record the episode for inspection; weakenRoute
      // doesn't record episodes itself, so we add one here.
      weakenRoute(this.graph, this.lastRoute, 1 - score, { alpha: this.config.alpha });
      this.graph.recordEpisode(this.lastQuery, this.lastRoute, score, episodeExtras);
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
    // If this router was constructed directly (e.g. by the CLI) the
    // shared store has no entry for this projectDir. Register our graph
    // so the flush has something to write, and so subsequent
    // getSharedMyceliumGraph callers see this instance.
    registerSharedMyceliumGraph(this.projectDir, this.graph);
    await flushSharedMyceliumGraph(this.projectDir);
  }

  getGraph(): MyceliumGraph {
    return this.graph;
  }

  getLastRoute(): string[] {
    return [...this.lastRoute];
  }

  getLastExplanation(): RouteExplanation | null {
    return this.lastExplanation;
  }

  getLastContextPackage(): ContextPackage | null {
    return this.lastContextPackage;
  }

  getLastClassification(): MyceliumTaskClassification | null {
    return this.lastClassification;
  }

  /** Convenience for CLI / debug surfaces. */
  formatLastExplanation(): string {
    return this.lastExplanation ? formatRouteExplanation(this.lastExplanation) : '(no route selected yet)';
  }

  stats(): ReturnType<MyceliumGraph['stats']> {
    return this.graph.stats();
  }

  /**
   * Apply explicit user feedback (thumbs-up = 1.0, thumbs-down = 0.0,
   * neutral = 0.5) to the most recent episode's route. Re-runs reinforcement
   * with the feedback as `userSatisfaction`, which carries 10% of the
   * reward formula. Episodes record `userFeedback` so the UI can show what
   * was overridden.
   */
  applyUserFeedback(feedback: 'up' | 'down' | 'neutral', note?: string): { applied: boolean; previousReward?: number; newReward?: number } {
    if (this.lastRoute.length === 0) return { applied: false };
    const satisfaction = feedback === 'up' ? 1 : feedback === 'down' ? 0 : 0.5;
    // Build a reward focused on user signal; other components default to neutral.
    const reward = {
      taskSuccess: feedback === 'down' ? 0.3 : 0.7,
      correctness: feedback === 'down' ? 0.3 : 0.7,
      usefulness: feedback === 'down' ? 0.2 : 0.8,
      costEfficiency: 0.5,
      userSatisfaction: satisfaction,
    };
    const previousEpisodes = this.graph.listEpisodes(1);
    const previousReward = previousEpisodes[0]?.reward;
    // Reinforce again with the feedback signal and tag the new episode.
    this.reinforce(reward, { blockReason: note });
    const newEpisodes = this.graph.listEpisodes(1);
    if (newEpisodes[0]) {
      // Tag the just-recorded episode with the explicit feedback channel.
      (newEpisodes[0] as { userFeedback?: 'up' | 'down' | 'neutral' }).userFeedback = feedback;
    }
    return { applied: true, previousReward, newReward: newEpisodes[0]?.reward };
  }
}

// ─── Load router from disk ──────────────────────────────────────────

export async function createMycelialRouter(projectDir: string, config?: MycelialRouterConfig): Promise<MycelialContextRouter> {
  const graph = await getSharedMyceliumGraph(projectDir);
  return new MycelialContextRouter(projectDir, graph, config);
}

// ─── Tool shortlisting (Mycelium advisory → actual selection) ───────

/**
 * Tools always exposed regardless of routing — the safety floor. Without these
 * the agent could lose the ability to read or write files, recall memory, or
 * author a skill, which would strand it mid-task. The floor guarantees a tool
 * is *offered*; it does not bypass the permission engine, which still gates
 * execution.
 */
export const DEFAULT_TOOL_FLOOR = ['file_read', 'file_write', 'file_edit', 'list_files', 'recall', 'skill', 'create_skill'];

export interface ToolShortlistOptions {
  /** Tool names always kept regardless of routing. Defaults to DEFAULT_TOOL_FLOOR. */
  floor?: string[];
  /** Max routed tools to keep (excludes floor). 0 / undefined = unlimited. */
  maxTools?: number;
}

/** Pull the labels of routed nodes that are tools out of a rich route result. */
export function toolNamesFromRoute(route: { nodes: Array<{ type: string; label: string }> }): string[] {
  return route.nodes.filter((n) => n.type === 'tool').map((n) => n.label);
}

/**
 * Promote Mycelium's advisory route into an actual tool shortlist for a turn.
 *
 * - When `routedToolNames` is empty (cold graph / no signal), returns ALL tools
 *   so the shortlist degrades to today's send-everything behaviour rather than
 *   starving the model. This is the escalation floor.
 * - Otherwise returns the routed subset of `allTools`, always unioned with any
 *   floor tool present, capped by `maxTools`.
 * - Never returns an empty list: if nothing matched, falls back to all tools.
 */
export function deriveToolShortlist<T extends { name: string }>(
  routedToolNames: string[],
  allTools: T[],
  options: ToolShortlistOptions = {},
): T[] {
  const routed = routedToolNames.filter(Boolean);
  if (routed.length === 0) return allTools;

  const floor = new Set(options.floor ?? DEFAULT_TOOL_FLOOR);
  const cap = options.maxTools && options.maxTools > 0 ? options.maxTools : Infinity;

  const routedSet = new Set<string>();
  for (const name of routed) {
    if (routedSet.size >= cap) break;
    routedSet.add(name);
  }

  const keep = allTools.filter((t) => routedSet.has(t.name) || floor.has(t.name));
  return keep.length > 0 ? keep : allTools;
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

// ─── Semantic relevance via Ollama embeddings ───────────────────────

export async function computeSemanticRelevance(
  query: string,
  nodes: MyceliumNode[],
  ollamaHost: string,
  model = 'nomic-embed-text',
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (nodes.length === 0) return scores;

  try {
    const texts = [query, ...nodes.map((n) => `${n.label} ${n.metadata?.description ?? ''}`.trim())];
    const embeddings = await embedBatch(texts, ollamaHost, model);

    if (embeddings.length !== texts.length) return scores;

    const queryVec = embeddings[0];
    for (let i = 0; i < nodes.length; i++) {
      const similarity = cosineSimilarity(queryVec, embeddings[i + 1]);
      // Blend embedding similarity with trust
      scores.set(nodes[i].id, similarity * 0.8 + nodes[i].trust * 0.2);
    }
  } catch {
    // Embedding failed — caller falls back to keyword relevance
  }

  return scores;
}

async function embedBatch(texts: string[], host: string, model: string): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${host.replace(/\/$/, '')}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
        signal: controller.signal,
      });
      if (!response.ok) return results;
      const data = (await response.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) return results;
      results.push(data.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}
