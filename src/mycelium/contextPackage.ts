// Mycelial Context Router — context package builder
//
// Converts a SelectedRoute (nodes + edges + reasons) into a structured
// context package the existing harness can consume. Also produces a
// human-readable route explanation for inspection / debugging.

import type { MyceliumGraph, MyceliumNode } from './graph';
import type { SelectedRoute, SelectionReason } from './activation';
import type { MyceliumTaskClassification } from './taskClassifier';

export interface ContextPackageItem {
  id: string;
  label: string;
  summary?: string;
  trust: number;
  cost: number;
  activation: number;
  protected?: boolean;
}

export interface ContextPackage {
  user_query: string;
  task_type: string;
  high_risk: boolean;
  exploration_rate: number;
  dry_run: boolean;
  selected_memories: ContextPackageItem[];
  selected_documents: ContextPackageItem[];
  selected_tools: ContextPackageItem[];
  selected_skills: ContextPackageItem[];
  selected_agents: ContextPackageItem[];
  selected_prompt_templates: ContextPackageItem[];
  selected_constraints: ContextPackageItem[];
  selected_verifiers: ContextPackageItem[];
  selected_workflows: ContextPackageItem[];
  selected_preferences: ContextPackageItem[];
  selected_safety: ContextPackageItem[];
  route_reason: string;
  execution_plan: string[];
  safety_notes: string[];
}

export interface BuildContextOptions {
  query: string;
  classification: MyceliumTaskClassification;
  route: SelectedRoute;
  dryRun: boolean;
}

export function buildContextPackage(opts: BuildContextOptions): ContextPackage {
  const { query, classification, route, dryRun } = opts;

  const groups = groupByType(route.nodes);
  const safetyNotes = collectSafetyNotes(route);

  return {
    user_query: query,
    task_type: classification.type,
    high_risk: classification.highRisk,
    exploration_rate: classification.explorationRate,
    dry_run: dryRun,
    // Group by node type, keeping the spec field names.
    selected_memories: groups.memory,
    selected_documents: groups.document,
    selected_tools: groups.tool,
    selected_skills: groups.skill,
    selected_agents: groups.agent,
    selected_prompt_templates: groups.prompt_template,
    selected_constraints: groups.constraint,
    selected_verifiers: groups.verifier,
    selected_workflows: groups.workflow,
    selected_preferences: groups.preference,
    selected_safety: groups.safety,
    route_reason: classification.reason,
    execution_plan: buildExecutionPlan(route),
    safety_notes: safetyNotes,
  };
}

// ─── Route explanation ─────────────────────────────────────────────

export interface RouteExplanation {
  taskType: string;
  explorationRate: number;
  selectedRoute: string[];
  whySelected: string[];
  exploitation: string[];
  exploration: string[];
  protectedRequired: string[];
  fallback: string[];
  contextSummary: { type: string; count: number }[];
  /** Code files included in the route from code intelligence seeding. */
  codeFiles: string[];
  graphUpdate?: { reinforced: number; decayed: number; archived: number; protectedFromDecay: number };
}

export function buildRouteExplanation(opts: {
  classification: MyceliumTaskClassification;
  route: SelectedRoute;
  graph: MyceliumGraph;
  graphUpdate?: RouteExplanation['graphUpdate'];
}): RouteExplanation {
  const { classification, route, graph, graphUpdate } = opts;

  // Build an ordered, *deduplicated* list of node IDs visited along the route.
  // Many edges may share an endpoint (e.g. several edges all targeting
  // `agent.verifier`); we want each node to appear at most once, in the
  // order it first becomes part of the path.
  const orderedRoute: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    orderedRoute.push(id);
  };
  for (const edge of route.edges) {
    visit(edge.source);
    visit(edge.target);
  }
  // Include any selected nodes that have no outgoing edge in the route
  // so they still show up in the explanation.
  for (const node of route.nodes) {
    if (node.type === 'query') continue;
    visit(node.id);
  }

  const why: string[] = [];
  why.push(`Task classified as ${classification.type} (${classification.reason}).`);
  if (classification.highRisk) why.push('High-risk task: exploration was clamped near zero.');
  if (route.protectedRequiredEdges.length > 0) {
    why.push(`Included ${route.protectedRequiredEdges.length} protected edge(s) (safety / verifier / required).`);
  }
  if (route.exploitedEdges.length > 0) {
    why.push(`Selected ${route.exploitedEdges.length} edge(s) by exploitation (highest score).`);
  }
  if (route.exploratoryEdges.length > 0) {
    why.push(`Tried ${route.exploratoryEdges.length} edge(s) by exploration.`);
  }
  if (route.fallbackEdges.length > 0) {
    why.push(`Used ${route.fallbackEdges.length} fallback edge(s) because no graph route existed.`);
  }

  const contextSummary = summariseByType(route.nodes);

  // Extract code_file nodes from the route for structural awareness.
  const codeFiles = route.nodes
    .filter((n) => n.type === 'code_file')
    .map((n) => n.label ?? n.id.replace('code.', ''));

  return {
    taskType: classification.type,
    explorationRate: classification.explorationRate,
    selectedRoute: orderedRoute,
    whySelected: why,
    exploitation: route.exploitedEdges.map(formatEdgeId),
    exploration: route.exploratoryEdges.map(formatEdgeId),
    protectedRequired: route.protectedRequiredEdges.map(formatEdgeId),
    fallback: route.fallbackEdges.map(formatEdgeId),
    contextSummary,
    codeFiles,
    graphUpdate,
  };
}

export function formatRouteExplanation(explanation: RouteExplanation): string {
  const lines: string[] = [];
  lines.push(`Task type: ${explanation.taskType}`);
  lines.push(`Exploration rate: ${explanation.explorationRate.toFixed(2)}`);
  lines.push('');
  lines.push('Selected route:');
  if (explanation.selectedRoute.length === 0) {
    lines.push('  (no edges selected)');
  } else {
    explanation.selectedRoute.forEach((id, i) => lines.push(`  ${i + 1}. ${id}`));
  }
  lines.push('');
  lines.push('Why selected:');
  for (const w of explanation.whySelected) lines.push(`  - ${w}`);
  if (explanation.exploitation.length > 0) {
    lines.push('');
    lines.push('Exploitation:');
    for (const e of explanation.exploitation) lines.push(`  - ${e}`);
  }
  if (explanation.exploration.length > 0) {
    lines.push('');
    lines.push('Exploration:');
    for (const e of explanation.exploration) lines.push(`  - ${e}`);
  }
  if (explanation.protectedRequired.length > 0) {
    lines.push('');
    lines.push('Protected required:');
    for (const e of explanation.protectedRequired) lines.push(`  - ${e}`);
  }
  if (explanation.fallback.length > 0) {
    lines.push('');
    lines.push('Fallback:');
    for (const e of explanation.fallback) lines.push(`  - ${e}`);
  }
  if (explanation.contextSummary.length > 0) {
    lines.push('');
    lines.push('Context package summary:');
    for (const c of explanation.contextSummary) lines.push(`  - ${c.count} ${c.type} node(s)`);
  }
  if (explanation.codeFiles.length > 0) {
    lines.push('');
    lines.push('Structurally relevant code files:');
    for (const f of explanation.codeFiles) lines.push(`  - ${f}`);
  }
  if (explanation.graphUpdate) {
    lines.push('');
    lines.push('Graph update after run:');
    lines.push(`  - reinforced ${explanation.graphUpdate.reinforced} edge(s)`);
    lines.push(`  - decayed ${explanation.graphUpdate.decayed} unused edge(s)`);
    lines.push(`  - archived ${explanation.graphUpdate.archived} weak edge(s)`);
    lines.push(`  - protected ${explanation.graphUpdate.protectedFromDecay} edge(s) from decay/pruning`);
  }
  return lines.join('\n');
}

// ─── Helpers ───────────────────────────────────────────────────────

function toItem(node: MyceliumNode): ContextPackageItem {
  return {
    id: node.id,
    label: node.label,
    summary: node.summary,
    trust: node.trust,
    cost: node.cost,
    activation: node.activation,
    protected: node.protected,
  };
}

function groupByType(nodes: MyceliumNode[]): Record<string, ContextPackageItem[]> {
  const groups: Record<string, ContextPackageItem[]> = {
    memory: [], document: [], tool: [], skill: [], agent: [],
    prompt_template: [], constraint: [], verifier: [], workflow: [],
    preference: [], safety: [], output: [], strategy: [], query: [],
  };
  for (const n of nodes) {
    if (!groups[n.type]) groups[n.type] = [];
    if (n.type === 'query') continue; // Don't echo the query node into context.
    groups[n.type].push(toItem(n));
  }
  return groups;
}

function summariseByType(nodes: MyceliumNode[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.type === 'query') continue;
    counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

function collectSafetyNotes(route: SelectedRoute): string[] {
  const notes: string[] = [];
  for (const node of route.nodes) {
    if (node.type === 'safety' && node.summary) notes.push(node.summary);
  }
  // Deduplicate.
  return Array.from(new Set(notes));
}

function buildExecutionPlan(route: SelectedRoute): string[] {
  const plan: string[] = [];
  // Workflow nodes first (they describe the overall arc).
  for (const node of route.nodes) {
    if (node.type === 'workflow') plan.push(`workflow: ${node.label}`);
  }
  // Then ordered agent activations.
  for (const node of route.nodes) {
    if (node.type === 'agent') plan.push(`agent: ${node.label}`);
  }
  // Verifiers run before final answer.
  for (const node of route.nodes) {
    if (node.type === 'verifier') plan.push(`verify: ${node.label}`);
  }
  return plan;
}

function formatEdgeId(edge: { source: string; target: string }): string {
  return `${edge.source} -> ${edge.target}`;
}

// Re-export helpers that consumers commonly need alongside the package.
export type { SelectionReason };
