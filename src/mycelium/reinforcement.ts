import type { MyceliumGraph, MyceliumEdge } from './graph';

// ─── Reinforcement parameters ───────────────────────────────────────

export interface ReinforcementConfig {
  /** Learning rate for successful routes (default 0.08). */
  alpha?: number;
  /** Decay rate for unused edges per cycle (default 0.02). */
  beta?: number;
  /** Cost penalty factor (default 0.01). */
  gamma?: number;
  /** Minimum weight before an unprotected edge is archived (default 0.03). */
  pruneThreshold?: number;
  /** Maximum number of decay cycles before force-pruning (default 100). */
  maxIdleCycles?: number;
  /** Floor below which protected edges never decay (default 0.25). */
  protectedFloor?: number;
}

const DEFAULT_CONFIG: Required<ReinforcementConfig> = {
  alpha: 0.08,
  beta: 0.02,
  gamma: 0.01,
  pruneThreshold: 0.03,
  maxIdleCycles: 100,
  protectedFloor: 0.25,
};

// ─── Reinforce a successful route ───────────────────────────────────

export interface EpisodeExtras {
  query?: string;
  taskType?: string;
  selectionReasons?: Record<string, string>;
  rewardComponents?: Record<string, number>;
  dryRun?: boolean;
  blocked?: boolean;
  blockReason?: string;
  appliedVerifiers?: string[];
}

export function reinforceRoute(
  graph: MyceliumGraph,
  route: string[],
  reward: number,
  config: ReinforcementConfig = {},
  episode?: EpisodeExtras,
): void {
  const { alpha, gamma } = { ...DEFAULT_CONFIG, ...config };

  for (let i = 0; i < route.length - 1; i++) {
    const edge = graph.getEdge(route[i], route[i + 1]);
    if (!edge) continue;

    const target = graph.getNode(edge.target);
    const cost = target?.cost ?? 0;

    // w(t+1) = w(t) + α · reward - γ · cost
    edge.weight += alpha * reward - gamma * cost;
    edge.weight = clamp(edge.weight);
    edge.totalReward += reward;
    edge.lastUsed = new Date().toISOString();

    if (reward > 0) edge.successCount++;
    else edge.failureCount++;

    // Increase trust on the target node
    if (target && reward > 0) {
      target.trust = clamp(target.trust + alpha * reward * 0.5);
    }
  }

  graph.recordEpisode(episode?.query ?? '', route, reward, {
    taskType: episode?.taskType,
    selectionReasons: episode?.selectionReasons,
    rewardComponents: episode?.rewardComponents,
    dryRun: episode?.dryRun,
    blocked: episode?.blocked,
    blockReason: episode?.blockReason,
    appliedVerifiers: episode?.appliedVerifiers,
  });
}

// ─── Weaken a failed route ──────────────────────────────────────────

export function weakenRoute(
  graph: MyceliumGraph,
  route: string[],
  penalty: number,
  config: ReinforcementConfig = {},
): void {
  const { alpha, protectedFloor } = { ...DEFAULT_CONFIG, ...config };

  for (let i = 0; i < route.length - 1; i++) {
    const edge = graph.getEdge(route[i], route[i + 1]);
    if (!edge) continue;

    // Protected safety/verifier edges that correctly blocked or required
    // verification must not be punished for a failed downstream outcome.
    if (edge.protected) {
      edge.lastUsed = new Date().toISOString();
      // Floor protects them from sliding below the configured minimum.
      if (edge.weight < protectedFloor) edge.weight = protectedFloor;
      continue;
    }

    edge.weight -= alpha * penalty;
    edge.weight = clamp(edge.weight);
    edge.failureCount++;
    edge.lastUsed = new Date().toISOString();

    const target = graph.getNode(edge.target);
    if (target && !target.protected) {
      target.trust = clamp(target.trust - alpha * penalty * 0.3);
    }
  }
}

// ─── Decay unused edges ─────────────────────────────────────────────

export function decayUnusedEdges(
  graph: MyceliumGraph,
  config: ReinforcementConfig = {},
): number {
  const { beta, protectedFloor } = { ...DEFAULT_CONFIG, ...config };
  let decayed = 0;

  for (const edge of graph.listEdges()) {
    edge.weight *= (1 - beta);
    edge.weight = clamp(edge.weight);
    // Protected edges never fall below the floor, even after many cycles.
    if (edge.protected && edge.weight < protectedFloor) {
      edge.weight = protectedFloor;
    }
    decayed++;
  }

  return decayed;
}

// ─── Archive ("prune") weak edges ───────────────────────────────────
//
// Soft-delete edges whose weight has decayed below the configured
// threshold. Protected edges are never archived. Returns the number
// of edges archived.

export function pruneDeadEdges(
  graph: MyceliumGraph,
  config: ReinforcementConfig = {},
): number {
  const { pruneThreshold } = { ...DEFAULT_CONFIG, ...config };
  let archived = 0;
  // Snapshot via listEdges() because archiveEdge mutates the underlying array.
  for (const edge of graph.listEdges()) {
    if (edge.protected) continue;
    if (edge.weight >= pruneThreshold) continue;
    if (graph.archiveEdge(edge.source, edge.target, `weight ${edge.weight.toFixed(3)} below threshold ${pruneThreshold}`)) {
      archived++;
    }
  }
  return archived;
}

// ─── Compute reward score ───────────────────────────────────────────

export interface RewardInput {
  taskSuccess?: number;    // 0–1
  correctness?: number;    // 0–1
  usefulness?: number;     // 0–1
  costEfficiency?: number; // 0–1
  userSatisfaction?: number; // 0–1
  novelty?: number;        // 0–1
}

export function computeReward(input: RewardInput): number {
  const {
    taskSuccess = 0,
    correctness = 0,
    usefulness = 0,
    costEfficiency = 0.5,
    userSatisfaction = 0.5,
    novelty = 0,
  } = input;

  return (
    0.35 * taskSuccess
    + 0.25 * correctness
    + 0.15 * usefulness
    + 0.10 * costEfficiency
    + 0.10 * userSatisfaction
    + 0.05 * novelty
  );
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
