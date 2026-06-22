// Code-graph tool — exposes the static code graph (.harness/code-graph.json)
// to the agent so it can answer symbol-level questions (callers, callees,
// exports, subgraph) instead of grep-guessing.
//
// Read-only, low risk. The graph itself is produced by
// `node scripts/build-code-graph.js`; this tool does NOT rebuild — if the
// file is missing, it returns a clear actionable error pointing at that
// command. Keeping rebuild out of the request path makes the tool fast and
// keeps the side-effect of file I/O explicit and CLI-driven.

import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

interface GraphNode {
  id: string;
  kind: 'file' | 'function' | 'method' | 'class' | 'interface' | 'variable';
  file: string;
  name: string;
  line: number;
  exported?: boolean;
}

interface GraphEdge {
  src: string;
  dst: string;
  kind: 'imports' | 'contains' | 'calls';
}

interface GraphFileEntry {
  path: string;
  hash: string;
  sloc: number;
  nodeId: string;
}

interface CodeGraph {
  schema: number;
  builtAt: string;
  repo: string;
  counts: Record<string, number>;
  files: GraphFileEntry[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const REBUILD_HINT = 'run: node scripts/build-code-graph.js';

function loadGraph(projectDir: string): CodeGraph | { error: string } {
  const graphPath = path.join(projectDir, '.harness', 'code-graph.json');
  if (!fs.existsSync(graphPath)) {
    return { error: `code-graph.json not found at ${graphPath}. ${REBUILD_HINT}` };
  }
  try {
    const raw = fs.readFileSync(graphPath, 'utf8');
    return JSON.parse(raw) as CodeGraph;
  } catch (err) {
    return { error: `failed to parse code-graph.json: ${(err as Error).message}. ${REBUILD_HINT}` };
  }
}

interface StalenessInfo {
  status: 'fresh' | 'stale' | 'unknown';
  changed: number;
  deleted: number;
  total: number;
  builtAt: string;
}

// Cheap staleness check: compare each tracked file's mtime against the graph's
// build time. We deliberately use mtime (one stat per file) rather than
// re-hashing every file on each query — the goal is a fast "this may be out of
// date" signal, not a precise diff. Over-warning is acceptable: a false stale
// just prompts a cheap rebuild, whereas a silent stale graph misleads the agent.
function computeStaleness(projectDir: string, g: CodeGraph): StalenessInfo {
  const builtAtMs = Date.parse(g.builtAt);
  const total = g.files?.length ?? 0;
  if (!Number.isFinite(builtAtMs) || total === 0) {
    return { status: 'unknown', changed: 0, deleted: 0, total, builtAt: g.builtAt };
  }
  let changed = 0;
  let deleted = 0;
  for (const f of g.files) {
    const abs = path.isAbsolute(f.path) ? f.path : path.join(projectDir, f.path);
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs > builtAtMs) changed++;
    } catch {
      deleted++;
    }
  }
  return { status: changed + deleted > 0 ? 'stale' : 'fresh', changed, deleted, total, builtAt: g.builtAt };
}

function stalenessBanner(s: StalenessInfo): string {
  if (s.status !== 'stale') return '';
  const missing = s.deleted ? `, ${s.deleted} missing` : '';
  return (
    `⚠️ code-graph may be STALE: ${s.changed} of ${s.total} tracked file(s) changed${missing} ` +
    `since it was built (${s.builtAt}). Results below may be out of date — ` +
    `rebuild with \`node scripts/build-code-graph.js\`.\n\n`
  );
}

function findNodesByName(g: CodeGraph, name: string): GraphNode[] {
  return g.nodes.filter((n) => n.name === name && n.kind !== 'file');
}

function locOf(n: GraphNode): string {
  return `${n.file}:${n.line}`;
}

function clampLimit(input: unknown, def: number, max: number): number {
  const n = typeof input === 'number' && Number.isFinite(input) ? input : def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function opCallers(g: CodeGraph, symbol: string, limit: number): string {
  const targets = findNodesByName(g, symbol);
  if (targets.length === 0) return `(no symbol named "${symbol}")`;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  for (const t of targets) {
    lines.push(`${t.kind} ${t.name} @ ${locOf(t)}`);
    const callers = g.edges
      .filter((e) => e.kind === 'calls' && e.dst === t.id)
      .map((e) => byId.get(e.src))
      .filter((n): n is GraphNode => Boolean(n));
    if (callers.length === 0) {
      lines.push('  (no callers found in graph)');
    } else {
      for (const c of callers.slice(0, limit)) lines.push(`  <- ${c.kind} ${c.name} @ ${locOf(c)}`);
      if (callers.length > limit) lines.push(`  ... +${callers.length - limit} more`);
    }
  }
  return lines.join('\n');
}

function opCallees(g: CodeGraph, symbol: string, limit: number): string {
  const sources = findNodesByName(g, symbol);
  if (sources.length === 0) return `(no symbol named "${symbol}")`;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  for (const s of sources) {
    lines.push(`${s.kind} ${s.name} @ ${locOf(s)}`);
    const callees = g.edges
      .filter((e) => e.kind === 'calls' && e.src === s.id)
      .map((e) => byId.get(e.dst))
      .filter((n): n is GraphNode => Boolean(n));
    if (callees.length === 0) {
      lines.push('  (no resolvable callees)');
    } else {
      for (const c of callees.slice(0, limit)) lines.push(`  -> ${c.kind} ${c.name} @ ${locOf(c)}`);
      if (callees.length > limit) lines.push(`  ... +${callees.length - limit} more`);
    }
  }
  return lines.join('\n');
}

function opExports(g: CodeGraph, fragment: string): string {
  const matches = g.files.filter((f) => f.path.includes(fragment));
  if (matches.length === 0) return `(no file path contains "${fragment}")`;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  for (const f of matches) {
    lines.push(f.path);
    const contained = g.edges
      .filter((e) => e.kind === 'contains' && e.src === f.nodeId)
      .map((e) => byId.get(e.dst))
      .filter((n): n is GraphNode => Boolean(n) && (n as GraphNode).exported === true);
    if (contained.length === 0) lines.push('  (no exports)');
    else for (const n of contained) lines.push(`  ${n.kind} ${n.name} @ line ${n.line}`);
  }
  return lines.join('\n');
}

function opAround(g: CodeGraph, symbol: string, depth: number, limit: number): string {
  const targets = findNodesByName(g, symbol);
  if (targets.length === 0) return `(no symbol named "${symbol}")`;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const visited = new Set(targets.map((t) => t.id));
  let frontier = new Set(visited);
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const e of g.edges) {
      if (e.kind !== 'calls') continue;
      if (frontier.has(e.src) && !visited.has(e.dst)) next.add(e.dst);
      if (frontier.has(e.dst) && !visited.has(e.src)) next.add(e.src);
    }
    if (next.size === 0) break;
    for (const id of next) visited.add(id);
    frontier = next;
  }
  const lines = [`subgraph around "${symbol}" (depth=${depth}, ${visited.size} nodes):`];
  let count = 0;
  for (const id of visited) {
    if (count++ >= limit) {
      lines.push(`  ... +${visited.size - limit} more`);
      break;
    }
    const n = byId.get(id);
    if (n) lines.push(`  ${n.kind} ${n.name} @ ${locOf(n)}`);
  }
  return lines.join('\n');
}

function opStats(g: CodeGraph): string {
  const incoming = new Map<string, number>();
  for (const e of g.edges) {
    if (e.kind !== 'calls') continue;
    incoming.set(e.dst, (incoming.get(e.dst) ?? 0) + 1);
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const top = [...incoming.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const lines = [
    `built: ${g.builtAt}`,
    `counts: ${JSON.stringify(g.counts)}`,
    'top 10 most-called:',
  ];
  for (const [id, count] of top) {
    const n = byId.get(id);
    if (n) lines.push(`  ${count}x  ${n.kind} ${n.name} @ ${n.file}:${n.line}`);
  }
  return lines.join('\n');
}

export function createCodeGraphTool(projectDir: string): Tool {
  return {
    name: 'code_graph',
    description:
      'Query the static code graph of src/ (TypeScript symbols, imports, calls). Resolves symbol-level questions like "who calls X" or "what does Y depend on" without grepping. Operations: callers (who calls SYMBOL), callees (what SYMBOL calls), exports (exports of files matching FRAGMENT), around (depth-N call subgraph around SYMBOL), stats (counts + top-10 most-called). Requires the graph file at .harness/code-graph.json — rebuild with `node scripts/build-code-graph.js`.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['callers', 'callees', 'exports', 'around', 'stats'],
          description: 'Which query to run.',
        },
        symbol: { type: 'string', description: 'Symbol name (callers/callees/around).' },
        fragment: { type: 'string', description: 'File-path substring (exports).' },
        depth: { type: 'number', description: 'Hop depth for around (default 1, max 5).' },
        limit: { type: 'number', description: 'Max results per section (default 50, max 500).' },
      },
      required: ['operation'],
    },
    isReadOnly: true,
    riskLevel: 'low',
    permissionCategory: 'read',
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const operation = typeof input.operation === 'string' ? input.operation : '';
      const symbol = typeof input.symbol === 'string' ? input.symbol.trim() : '';
      const fragment = typeof input.fragment === 'string' ? input.fragment : '';
      const depth = clampLimit(input.depth, 1, 5);
      const limit = clampLimit(input.limit, 50, 500);

      const loaded = loadGraph(projectDir);
      if ('error' in loaded) {
        return { success: false, output: `code_graph: ${loaded.error}`, error: loaded.error };
      }

      const banner = stalenessBanner(computeStaleness(projectDir, loaded));
      const ok = (output: string): ToolResult => ({ success: true, output: banner + output });

      switch (operation) {
        case 'callers':
          if (!symbol) return { success: false, output: 'code_graph callers: symbol is required', error: 'missing symbol' };
          return ok(opCallers(loaded, symbol, limit));
        case 'callees':
          if (!symbol) return { success: false, output: 'code_graph callees: symbol is required', error: 'missing symbol' };
          return ok(opCallees(loaded, symbol, limit));
        case 'exports':
          return ok(opExports(loaded, fragment));
        case 'around':
          if (!symbol) return { success: false, output: 'code_graph around: symbol is required', error: 'missing symbol' };
          return ok(opAround(loaded, symbol, depth, limit));
        case 'stats':
          return ok(opStats(loaded));
        default:
          return {
            success: false,
            output: `code_graph: unknown operation "${operation}". Use callers|callees|exports|around|stats.`,
            error: 'unknown operation',
          };
      }
    },
  };
}

/** Static export for the registry default. Real projectDir is injected at runtime. */
export const CodeGraphTool: Tool = createCodeGraphTool(process.cwd());
