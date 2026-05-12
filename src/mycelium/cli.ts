// Mycelium CLI subcommands
//
// Standalone subcommand handler for the `harness mycelium ...` family.
// Implements the debug commands listed in the Network.md spec:
//   init, seed, status, route, show-route, show-node, show-edges,
//   decay, prune, export.

import * as path from 'path';
import { promises as fs } from 'fs';
import { loadMyceliumGraph, saveMyceliumGraph, MyceliumGraph } from './graph';
import { MycelialContextRouter } from './router';
import { decayUnusedEdges, pruneDeadEdges } from './reinforcement';
import { formatRouteExplanation } from './contextPackage';
import { classifyTask } from './taskClassifier';

export interface MyceliumCliOptions {
  projectDir: string;
  args: string[];
}

export interface MyceliumCliResult {
  exitCode: number;
  output: string;
}

const HELP = `Usage: harness mycelium <subcommand> [options]

Subcommands:
  init                          Create the mycelium graph store on disk.
  seed                          Seed generic safety / agent / verifier / workflow nodes.
  status (router-status)        Show counts of nodes, edges, episodes, archived edges, and recent reward.
  route --query "..." [--dry-run]   Classify, route, and print the explanation. --dry-run does not mutate the graph.
  show-route                    Show the most recently selected route explanation.
  show-node <id>                Show node details (label, type, trust, cost, protected).
  show-edges <id>               Show incoming/outgoing edges for a node.
  decay [--dry-run]             Apply one decay cycle to all unused edges. --dry-run previews the new weights without mutating.
  prune [--dry-run]             Archive (soft-delete) edges below the prune threshold. --dry-run previews without mutating.
  export <path>                 Export the graph as JSON.
  classify --query "..."        Print the task classifier verdict for a query.
  help                          Show this help.
`;

export async function runMyceliumCli(opts: MyceliumCliOptions): Promise<MyceliumCliResult> {
  const sub = opts.args[0];
  const rest = opts.args.slice(1);

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    return { exitCode: 0, output: HELP };
  }

  switch (sub) {
    case 'init':
      return cmdInit(opts.projectDir);
    case 'seed':
      return cmdSeed(opts.projectDir);
    case 'status':
    case 'router-status':
      return cmdStatus(opts.projectDir);
    case 'route':
      return cmdRoute(opts.projectDir, rest);
    case 'show-route':
      return cmdShowRoute(opts.projectDir);
    case 'show-node':
      return cmdShowNode(opts.projectDir, rest[0]);
    case 'show-edges':
      return cmdShowEdges(opts.projectDir, rest[0]);
    case 'decay':
      return cmdDecay(opts.projectDir, rest);
    case 'prune':
      return cmdPrune(opts.projectDir, rest);
    case 'export':
      return cmdExport(opts.projectDir, rest[0]);
    case 'classify':
      return cmdClassify(rest);
    default:
      return { exitCode: 1, output: `Unknown subcommand: ${sub}\n\n${HELP}` };
  }
}

// ─── Subcommand implementations ────────────────────────────────────

async function cmdInit(projectDir: string): Promise<MyceliumCliResult> {
  const graph = await loadMyceliumGraph(projectDir); // creates empty if missing
  await saveMyceliumGraph(projectDir, graph);
  const stats = graph.stats();
  return {
    exitCode: 0,
    output: `Mycelium graph initialised at ${graphPath(projectDir)}\n  nodes: ${stats.nodes}, edges: ${stats.edges}, episodes: ${stats.episodes}`,
  };
}

async function cmdSeed(projectDir: string): Promise<MyceliumCliResult> {
  const graph = await loadMyceliumGraph(projectDir);
  const router = new MycelialContextRouter(projectDir, graph);
  const summary = router.seedGeneric();
  await router.save();
  return {
    exitCode: 0,
    output: `Seeded generic graph:
  nodes added: ${summary.nodesAdded}
  edges added: ${summary.edgesAdded}
  protected nodes (cumulative): ${summary.protectedNodes}
  protected edges (cumulative): ${summary.protectedEdges}`,
  };
}

async function cmdStatus(projectDir: string): Promise<MyceliumCliResult> {
  const graph = await loadMyceliumGraph(projectDir);
  const stats = graph.stats();
  const recent = graph.listEpisodes(20);
  const avgReward = recent.length > 0
    ? recent.reduce((sum, e) => sum + e.reward, 0) / recent.length
    : 0;
  return {
    exitCode: 0,
    output: `Mycelium router status
  nodes:           ${stats.nodes}
  edges:           ${stats.edges}
  protected nodes: ${stats.protectedNodes}
  protected edges: ${stats.protectedEdges}
  archived edges:  ${stats.archivedEdges}
  episodes (total): ${stats.episodes}
  avg edge weight:  ${stats.avgWeight}
  recent avg reward (last ${recent.length}): ${avgReward.toFixed(3)}`,
  };
}

async function cmdRoute(projectDir: string, args: string[]): Promise<MyceliumCliResult> {
  const query = takeOption(args, '--query');
  if (!query) return { exitCode: 1, output: 'route requires --query "..."' };
  const dryRun = args.includes('--dry-run');

  const graph = await loadMyceliumGraph(projectDir);
  const router = new MycelialContextRouter(projectDir, graph);
  // If the graph is empty, seed first so dry-runs produce useful output.
  if (graph.listNodes().length === 0) router.seedGeneric();
  const result = router.routeQueryRich(query, { dryRun });

  // In dry-run mode we explicitly do NOT save graph mutations.
  if (!dryRun) {
    await router.save();
  }

  const explanation = formatRouteExplanation(result.explanation);
  return {
    exitCode: 0,
    output: `${dryRun ? '[DRY RUN] ' : ''}Routed query: ${JSON.stringify(query)}\n\n${explanation}\n\nContext package summary:\n  task_type: ${result.contextPackage.task_type}\n  high_risk: ${result.contextPackage.high_risk}\n  exploration_rate: ${result.contextPackage.exploration_rate}\n  selected: ${result.contextPackage.selected_agents.length} agents, ${result.contextPackage.selected_tools.length} tools, ${result.contextPackage.selected_verifiers.length} verifiers, ${result.contextPackage.selected_safety.length} safety, ${result.contextPackage.selected_workflows.length} workflows`,
  };
}

async function cmdShowRoute(projectDir: string): Promise<MyceliumCliResult> {
  const graph = await loadMyceliumGraph(projectDir);
  const last = graph.listEpisodes(1)[0];
  if (!last) return { exitCode: 0, output: '(no episodes recorded yet)' };
  const lines = [
    `Last episode ${last.id}`,
    `  query:    ${last.query.slice(0, 120)}`,
    `  taskType: ${last.taskType ?? 'unknown'}`,
    `  reward:   ${last.reward.toFixed(3)}`,
    `  dryRun:   ${last.dryRun ?? false}`,
    `  route:    ${last.route.length === 0 ? '(empty)' : ''}`,
  ];
  for (const id of last.route) lines.push(`    - ${id}`);
  return { exitCode: 0, output: lines.join('\n') };
}

async function cmdShowNode(projectDir: string, id: string | undefined): Promise<MyceliumCliResult> {
  if (!id) return { exitCode: 1, output: 'show-node requires a node id' };
  const graph = await loadMyceliumGraph(projectDir);
  const node = graph.getNode(id);
  if (!node) return { exitCode: 1, output: `Node not found: ${id}` };
  return {
    exitCode: 0,
    output: `Node ${node.id}
  type:       ${node.type}
  label:      ${node.label}
  trust:      ${node.trust.toFixed(3)}
  cost:       ${node.cost.toFixed(3)}
  protected:  ${node.protected ?? false}
  summary:    ${node.summary ?? '-'}
  outgoing:   ${graph.outgoingEdges(id).length}
  incoming:   ${graph.incomingEdges(id).length}`,
  };
}

async function cmdShowEdges(projectDir: string, id: string | undefined): Promise<MyceliumCliResult> {
  if (!id) return { exitCode: 1, output: 'show-edges requires a node id' };
  const graph = await loadMyceliumGraph(projectDir);
  if (!graph.getNode(id)) return { exitCode: 1, output: `Node not found: ${id}` };

  const lines: string[] = [`Edges for ${id}:`];
  lines.push('  outgoing:');
  for (const e of graph.outgoingEdges(id)) {
    lines.push(`    -> ${e.target}  weight=${e.weight.toFixed(3)}  uses=${e.successCount + e.failureCount}  protected=${e.protected}`);
  }
  lines.push('  incoming:');
  for (const e of graph.incomingEdges(id)) {
    lines.push(`    <- ${e.source}  weight=${e.weight.toFixed(3)}  uses=${e.successCount + e.failureCount}  protected=${e.protected}`);
  }
  return { exitCode: 0, output: lines.join('\n') };
}

async function cmdDecay(projectDir: string, args: string[]): Promise<MyceliumCliResult> {
  const dryRun = args.includes('--dry-run');
  const graph = await loadMyceliumGraph(projectDir);

  if (dryRun) {
    // Preview the post-decay weights without writing to disk. Mirrors the
    // beta=0.02 default and protected-floor (0.25) clamp from reinforcement.ts.
    const BETA = 0.02;
    const PROTECTED_FLOOR = 0.25;
    const PRUNE_THRESHOLD = 0.03;
    const projections = graph.listEdges().map((edge) => {
      let next = edge.weight * (1 - BETA);
      if (edge.protected && next < PROTECTED_FLOOR) next = PROTECTED_FLOOR;
      const wouldArchive = !edge.protected && next < PRUNE_THRESHOLD;
      return { source: edge.source, target: edge.target, before: edge.weight, after: next, protected: edge.protected, wouldArchive };
    });
    if (projections.length === 0) return { exitCode: 0, output: '[DRY RUN] Graph has no edges to decay.' };

    const newlyArchivable = projections.filter((p) => p.wouldArchive);
    const lines = [`[DRY RUN] Would decay ${projections.length} edge(s) (beta=${BETA}, protected floor=${PROTECTED_FLOOR}).`];
    if (newlyArchivable.length > 0) {
      lines.push(`\nAfter this decay cycle, ${newlyArchivable.length} edge(s) would fall below the prune threshold (${PRUNE_THRESHOLD}):`);
      for (const p of newlyArchivable) {
        lines.push(`  ${p.source} -> ${p.target}  ${p.before.toFixed(3)} -> ${p.after.toFixed(3)}`);
      }
    } else {
      lines.push('No edges would cross the prune threshold this cycle.');
    }
    return { exitCode: 0, output: lines.join('\n') };
  }

  const decayed = decayUnusedEdges(graph);
  await saveMyceliumGraph(projectDir, graph);
  return { exitCode: 0, output: `Decayed ${decayed} edge(s).` };
}

async function cmdPrune(projectDir: string, args: string[]): Promise<MyceliumCliResult> {
  const dryRun = args.includes('--dry-run');
  const graph = await loadMyceliumGraph(projectDir);

  if (dryRun) {
    // Preview: list every edge that *would* be archived without mutating.
    const PRUNE_THRESHOLD = 0.03;
    const candidates = graph.listEdges().filter((e) => !e.protected && e.weight < PRUNE_THRESHOLD);
    if (candidates.length === 0) {
      return { exitCode: 0, output: '[DRY RUN] No edges would be archived (threshold 0.03).' };
    }
    const lines = ['[DRY RUN] Would archive the following edge(s):'];
    for (const edge of candidates) {
      lines.push(`  ${edge.source} -> ${edge.target}  weight=${edge.weight.toFixed(3)}  uses=${edge.successCount + edge.failureCount}`);
    }
    lines.push(`\nTotal: ${candidates.length} edge(s) would be archived. Run \`mycelium prune\` (without --dry-run) to apply.`);
    return { exitCode: 0, output: lines.join('\n') };
  }

  const archived = pruneDeadEdges(graph);
  await saveMyceliumGraph(projectDir, graph);
  return { exitCode: 0, output: `Archived ${archived} weak edge(s).` };
}

async function cmdExport(projectDir: string, target: string | undefined): Promise<MyceliumCliResult> {
  if (!target) return { exitCode: 1, output: 'export requires a destination path' };
  const graph = await loadMyceliumGraph(projectDir);
  const absolute = path.resolve(target);
  await fs.writeFile(absolute, JSON.stringify(graph.toJSON(), null, 2), 'utf-8');
  return { exitCode: 0, output: `Exported graph to ${absolute}` };
}

async function cmdClassify(args: string[]): Promise<MyceliumCliResult> {
  const query = takeOption(args, '--query');
  if (!query) return { exitCode: 1, output: 'classify requires --query "..."' };
  const c = classifyTask(query);
  return {
    exitCode: 0,
    output: `Task classification:
  type:              ${c.type}
  high_risk:         ${c.highRisk}
  exploration_rate:  ${c.explorationRate}
  max_selected_nodes: ${c.maxSelectedNodes}
  max_depth:         ${c.maxDepth}
  matched_keywords:  ${c.matchedKeywords.join(', ') || '(none)'}
  reason:            ${c.reason}`,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function takeOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

function graphPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'mycelium', 'graph.json');
}
