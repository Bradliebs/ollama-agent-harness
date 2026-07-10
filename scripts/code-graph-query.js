#!/usr/bin/env node
/**
 * Code-graph query CLI (spike, v0).
 *
 * Reads .harness/code-graph.json and answers symbol-level questions.
 *
 * Usage:
 *   node scripts/code-graph-query.js callers <symbol-name>
 *   node scripts/code-graph-query.js callees <symbol-name>
 *   node scripts/code-graph-query.js exports <file-path-fragment>
 *   node scripts/code-graph-query.js around <symbol-name> [depth=1]
 *   node scripts/code-graph-query.js stats
 *
 * Symbol matching is exact-name. If multiple nodes share the name (common
 * for class methods), all are listed.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const GRAPH_FILE = path.join(REPO_ROOT, '.harness', 'code-graph.json');

function loadGraph() {
  if (!fs.existsSync(GRAPH_FILE)) {
    console.error(`[code-graph] missing ${GRAPH_FILE} — run: node scripts/build-code-graph.js`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
}

function findNodesByName(g, name) {
  return g.nodes.filter((n) => n.name === name && n.kind !== 'file');
}

function locOf(n) {
  return `${n.file}:${n.line}`;
}

function cmdCallers(g, name) {
  const targets = findNodesByName(g, name);
  if (targets.length === 0) {
    console.log(`(no symbol named "${name}")`);
    return;
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const t of targets) {
    console.log(`\n${t.kind} ${t.name} @ ${locOf(t)}`);
    const callers = g.edges
      .filter((e) => e.kind === 'calls' && e.dst === t.id)
      .map((e) => byId.get(e.src))
      .filter(Boolean);
    if (callers.length === 0) {
      console.log('  (no callers found in graph)');
    } else {
      for (const c of callers) console.log(`  <- ${c.kind} ${c.name} @ ${locOf(c)}`);
    }
  }
}

function cmdCallees(g, name) {
  const sources = findNodesByName(g, name);
  if (sources.length === 0) {
    console.log(`(no symbol named "${name}")`);
    return;
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const s of sources) {
    console.log(`\n${s.kind} ${s.name} @ ${locOf(s)}`);
    const callees = g.edges
      .filter((e) => e.kind === 'calls' && e.src === s.id)
      .map((e) => byId.get(e.dst))
      .filter(Boolean);
    if (callees.length === 0) {
      console.log('  (no resolvable callees)');
    } else {
      for (const c of callees) console.log(`  -> ${c.kind} ${c.name} @ ${locOf(c)}`);
    }
  }
}

function cmdExports(g, fragment) {
  const matches = g.files.filter((f) => f.path.includes(fragment));
  if (matches.length === 0) {
    console.log(`(no file path contains "${fragment}")`);
    return;
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const f of matches) {
    console.log(`\n${f.path}`);
    const contained = g.edges
      .filter((e) => e.kind === 'contains' && e.src === f.nodeId)
      .map((e) => byId.get(e.dst))
      .filter((n) => n && n.exported);
    if (contained.length === 0) console.log('  (no exports)');
    else for (const n of contained) console.log(`  ${n.kind} ${n.name} @ line ${n.line}`);
  }
}

function cmdAround(g, name, depth) {
  const targets = findNodesByName(g, name);
  if (targets.length === 0) {
    console.log(`(no symbol named "${name}")`);
    return;
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const visited = new Set(targets.map((t) => t.id));
  const frontier = new Set(visited);

  for (let d = 0; d < depth; d++) {
    const next = new Set();
    for (const e of g.edges) {
      if (e.kind !== 'calls') continue;
      if (frontier.has(e.src) && !visited.has(e.dst)) next.add(e.dst);
      if (frontier.has(e.dst) && !visited.has(e.src)) next.add(e.src);
    }
    for (const id of next) visited.add(id);
    frontier.clear();
    for (const id of next) frontier.add(id);
    if (next.size === 0) break;
  }

  console.log(`\nsubgraph around "${name}" (depth=${depth}, ${visited.size} nodes):`);
  for (const id of visited) {
    const n = byId.get(id);
    if (n) console.log(`  ${n.kind} ${n.name} @ ${locOf(n)}`);
  }
}

function cmdStats(g) {
  console.log('built:', g.builtAt);
  console.log('counts:', g.counts);
  // Top-10 most-called symbols.
  const incoming = new Map();
  for (const e of g.edges) {
    if (e.kind !== 'calls') continue;
    incoming.set(e.dst, (incoming.get(e.dst) ?? 0) + 1);
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const top = [...incoming.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\ntop 10 most-called:');
  for (const [id, count] of top) {
    const n = byId.get(id);
    if (n) console.log(`  ${count}x  ${n.kind} ${n.name} @ ${n.file}:${n.line}`);
  }
}

function main() {
  const [, , cmd, ...args] = process.argv;
  const g = loadGraph();
  switch (cmd) {
    case 'callers':
      cmdCallers(g, args[0]);
      break;
    case 'callees':
      cmdCallees(g, args[0]);
      break;
    case 'exports':
      cmdExports(g, args[0] ?? '');
      break;
    case 'around':
      cmdAround(g, args[0], Math.max(1, parseInt(args[1] ?? '1', 10)));
      break;
    case 'stats':
      cmdStats(g);
      break;
    default:
      console.error('usage: code-graph-query.js <callers|callees|exports|around|stats> [args...]');
      process.exit(2);
  }
}

main();
