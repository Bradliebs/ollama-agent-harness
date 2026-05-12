// Knowledge graph → Mermaid diagram source.
//
// Pure: takes records, returns a Mermaid `graph TD` string. Node ids are
// stabilized hashes; labels show entity names. Edges show relations.
//
// Capped at MAX_NODES + MAX_EDGES per call to keep the rendered diagram
// readable. When `focus` is provided, only nodes within 1 hop of the focus
// entity name (case-insensitive) are included.

import type { GraphEdge, GraphEntity, GraphRecord } from './knowledgeGraph';

const MAX_NODES = 30;
const MAX_EDGES = 60;

export interface MermaidGraphOptions {
  focus?: string;
}

export function composeMermaidGraph(records: GraphRecord[], options: MermaidGraphOptions = {}): string {
  const entities = records.filter((r): r is GraphEntity => r.kind === 'entity');
  const edges = records.filter((r): r is GraphEdge => r.kind === 'edge');

  // Dedupe entities by id (last-write-wins)
  const entityById = new Map<string, GraphEntity>();
  for (const e of entities) entityById.set(e.id, e);

  let workingEntities = Array.from(entityById.values());
  let workingEdges = edges;

  if (options.focus) {
    const focusName = options.focus.toLowerCase();
    const focusEntities = workingEntities.filter((e) => e.name.toLowerCase().includes(focusName));
    const focusIds = new Set(focusEntities.map((e) => e.id));
    const oneHopEdges = workingEdges.filter((e) => focusIds.has(e.from) || focusIds.has(e.to));
    const reachableIds = new Set(focusIds);
    for (const e of oneHopEdges) { reachableIds.add(e.from); reachableIds.add(e.to); }
    workingEntities = workingEntities.filter((e) => reachableIds.has(e.id));
    workingEdges = oneHopEdges;
  }

  workingEntities = workingEntities.slice(0, MAX_NODES);
  const includedIds = new Set(workingEntities.map((e) => e.id));
  workingEdges = workingEdges.filter((e) => includedIds.has(e.from) && includedIds.has(e.to)).slice(0, MAX_EDGES);

  const lines: string[] = ['graph TD'];
  if (workingEntities.length === 0) {
    lines.push('  empty["(empty graph)"]');
    return lines.join('\n');
  }

  for (const e of workingEntities) {
    const id = sanitizeId(e.id);
    const label = sanitizeLabel(`${e.type}: ${e.name}`);
    lines.push(`  ${id}["${label}"]`);
  }
  for (const e of workingEdges) {
    const from = sanitizeId(e.from);
    const to = sanitizeId(e.to);
    const label = sanitizeLabel(e.relation);
    lines.push(`  ${from} -->|${label}| ${to}`);
  }
  return lines.join('\n');
}

function sanitizeId(raw: string): string {
  return 'n_' + raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
}

function sanitizeLabel(raw: string): string {
  return raw.replace(/["\\]/g, ' ').slice(0, 60);
}
