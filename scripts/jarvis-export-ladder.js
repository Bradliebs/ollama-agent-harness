#!/usr/bin/env node
// Export the trust ladder snapshot to stdout (or a file when --out is set).

const fs = require('fs');
const path = require('path');

async function main() {
  try { require('ts-node/register'); } catch {
    process.stderr.write('jarvis-export-ladder requires ts-node (already a dev dep).\n');
    process.exit(1);
  }
  const projectDir = process.env.HARNESS_PROJECT_DIR || process.cwd();
  const { loadTrustLadder } = require(path.resolve(__dirname, '..', 'src', 'jarvis', 'trustLadder'));
  const snap = await loadTrustLadder(projectDir);
  const json = JSON.stringify(snap, null, 2);
  const outArgIdx = process.argv.indexOf('--out');
  if (outArgIdx !== -1 && process.argv[outArgIdx + 1]) {
    fs.writeFileSync(process.argv[outArgIdx + 1], json + '\n', 'utf-8');
    process.stderr.write(`Wrote ladder to ${process.argv[outArgIdx + 1]}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main().catch((err) => { process.stderr.write(`fatal: ${err.message}\n`); process.exit(1); });
