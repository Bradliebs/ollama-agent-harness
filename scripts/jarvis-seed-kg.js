#!/usr/bin/env node
// Jarvis knowledge graph seed — one-time historical ingest.
//
// Walks `.harness/evidence/runs.jsonl` (and any sibling shards) and feeds
// every evidence card through the jarvis evidence ingester so `recall("…")`
// returns useful answers on day one.
//
// Usage:
//   node scripts/jarvis-seed-kg.js [--limit 5000]

const fs = require('fs');
const path = require('path');

async function main() {
  try {
    require('ts-node/register');
  } catch {
    process.stderr.write('jarvis-seed-kg requires ts-node (already a dev dep).\n');
    process.exit(1);
  }

  const projectDir = process.env.HARNESS_PROJECT_DIR || process.cwd();
  const argLimit = process.argv.find((a, i) => process.argv[i - 1] === '--limit');
  const limit = argLimit ? parseInt(argLimit, 10) : 5000;

  const evidenceFile = path.join(projectDir, '.harness', 'evidence', 'runs.jsonl');
  if (!fs.existsSync(evidenceFile)) {
    process.stdout.write(`No evidence file at ${evidenceFile}; nothing to seed.\n`);
    return;
  }

  const { ingestEvidenceCard } = require(path.resolve(__dirname, '..', 'src', 'jarvis', 'evidenceIngester'));

  const lines = fs.readFileSync(evidenceFile, 'utf-8').split('\n').filter(Boolean).slice(-limit);
  let ok = 0;
  let fail = 0;
  for (const line of lines) {
    try {
      const card = JSON.parse(line);
      await ingestEvidenceCard(projectDir, card);
      ok++;
    } catch (err) {
      fail++;
    }
  }
  process.stdout.write(`Seeded ${ok} card(s) into knowledge graph (failures: ${fail}, source: ${evidenceFile}).\n`);
}

main().catch((err) => {
  process.stderr.write(`jarvis-seed-kg fatal: ${err.message}\n`);
  process.exit(1);
});
