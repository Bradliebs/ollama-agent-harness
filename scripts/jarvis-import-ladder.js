#!/usr/bin/env node
// Import a trust-ladder JSON into the local snapshot.
//
// Usage:
//   node scripts/jarvis-import-ladder.js --in path/to/ladder.json [--strategy max-rung-wins|last-wins]

const fs = require('fs');
const path = require('path');

async function main() {
  try { require('ts-node/register'); } catch {
    process.stderr.write('jarvis-import-ladder requires ts-node (already a dev dep).\n');
    process.exit(1);
  }
  const inIdx = process.argv.indexOf('--in');
  if (inIdx === -1 || !process.argv[inIdx + 1]) {
    process.stderr.write('Usage: jarvis-import-ladder.js --in <file> [--strategy max-rung-wins|last-wins]\n');
    process.exit(2);
  }
  const stratIdx = process.argv.indexOf('--strategy');
  const strategy = stratIdx !== -1 ? process.argv[stratIdx + 1] : 'max-rung-wins';
  const projectDir = process.env.HARNESS_PROJECT_DIR || process.cwd();

  const incoming = JSON.parse(fs.readFileSync(process.argv[inIdx + 1], 'utf-8'));
  const { loadTrustLadder, saveTrustLadder } = require(path.resolve(__dirname, '..', 'src', 'jarvis', 'trustLadder'));
  const { mergeLadders } = require(path.resolve(__dirname, '..', 'src', 'jarvis', 'ladderImport'));

  const local = await loadTrustLadder(projectDir);
  const { merged, stats } = mergeLadders(local, incoming, strategy);
  await saveTrustLadder(projectDir, merged);
  process.stdout.write(`Imported ladder (strategy=${strategy}). Promoted: ${stats.promoted.length}, demoted: ${stats.demoted.length}, added: ${stats.added.length}, unchanged: ${stats.unchanged.length}.\n`);
}

main().catch((err) => { process.stderr.write(`fatal: ${err.message}\n`); process.exit(1); });
