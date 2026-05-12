#!/usr/bin/env node
// Jarvis knowledge-graph compaction.
//
// Rewrites .harness/jarvis/knowledge.jsonl as a smaller, semantically
// equivalent snapshot. Append-only growth keeps history; this script
// merges duplicate entities, dedupes equivalent edges, retains facts.

const path = require('path');

async function main() {
  try { require('ts-node/register'); } catch {
    process.stderr.write('jarvis-compact-kg requires ts-node (already a dev dep).\n');
    process.exit(1);
  }
  const projectDir = process.env.HARNESS_PROJECT_DIR || process.cwd();
  const { compactKnowledgeGraph } = require(path.resolve(__dirname, '..', 'src', 'jarvis', 'knowledgeGraphCompaction'));
  const stats = await compactKnowledgeGraph(projectDir);
  process.stdout.write(`Compacted KG at ${projectDir}: ${stats.before} → ${stats.after} records (entities merged: ${stats.entitiesMerged}, edges deduped: ${stats.edgesDeduped}, facts retained: ${stats.factsRetained}).\n`);
}

main().catch((err) => {
  process.stderr.write(`jarvis-compact-kg fatal: ${err.message}\n`);
  process.exit(1);
});
