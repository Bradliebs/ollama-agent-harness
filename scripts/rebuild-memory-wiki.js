#!/usr/bin/env node
/**
 * scripts/rebuild-memory-wiki.js — CLI for the personal memory wiki.
 *
 * Loads every entry from the harness's semantic memory store and renders
 * the cookbook personal-wiki blueprint to disk so the user can browse
 * their history as a small static site.
 *
 * Usage:
 *   node scripts/rebuild-memory-wiki.js
 *   node scripts/rebuild-memory-wiki.js --out .harness/memory-wiki
 *   node scripts/rebuild-memory-wiki.js --project /path/to/project --limit 500
 *
 * Exit codes:
 *   0  wiki rebuilt successfully
 *   1  invalid arguments
 *   2  runtime error while loading memory or writing the wiki
 */

'use strict';

const { resolve } = require('node:path');

function parseArgs(argv) {
  const args = { out: '.harness/memory-wiki', limit: 1000, project: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--limit' || a === '-l') args.limit = Number(argv[++i]);
    else if (a === '--project' || a === '-p') args.project = argv[++i];
    else return { error: `unknown argument: ${a}` };
  }
  if (!args.out || !args.project) return { error: 'missing --out or --project value' };
  if (!Number.isFinite(args.limit) || args.limit <= 0) return { error: '--limit must be a positive number' };
  return args;
}

function usage() {
  process.stdout.write(
    'Usage: node scripts/rebuild-memory-wiki.js [--out DIR] [--limit N] [--project DIR]\n' +
    '\n' +
    'Options:\n' +
    '  --out, -o DIR        Output directory (default: .harness/memory-wiki)\n' +
    '  --limit, -l N        Max number of entries to render (default: 1000)\n' +
    '  --project, -p DIR    Project root to read semantic memory from (default: cwd)\n' +
    '  --help, -h           Show this message\n',
  );
}

function loadModules() {
  // Prefer the source .ts modules via ts-node when available (dev / source
  // checkouts), fall back to the compiled dist/ for packaged installs.
  let tsNodeRegistered = false;
  try {
    require('ts-node/register');
    tsNodeRegistered = true;
  } catch {
    // ts-node missing — dist/ fallbacks below will handle this.
  }

  let semanticMemory;
  let adapter;
  let blueprint;
  try {
    semanticMemory = require('../src/persistence/semanticMemory');
    adapter = require('../src/services/memoryWikiAdapter');
  } catch {
    semanticMemory = require('../dist/persistence/semanticMemory');
    adapter = require('../dist/services/memoryWikiAdapter');
  }
  try {
    blueprint = require('../cookbook/blueprint-personal-wiki');
  } catch (err) {
    if (!tsNodeRegistered) {
      throw new Error('cookbook/blueprint-personal-wiki requires ts-node; install dev deps and retry');
    }
    throw err;
  }
  return { semanticMemory, adapter, blueprint };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.error) { process.stderr.write(`[wiki] ${args.error}\n\n`); usage(); return 1; }

  const { semanticMemory, adapter, blueprint } = loadModules();
  const projectDir = resolve(args.project);
  const outDir = resolve(args.out);

  const rawEntries = await semanticMemory.rebuildSemanticMemory(projectDir);
  const trimmed = rawEntries
    .slice()
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    .slice(0, args.limit);
  const entries = adapter.entriesToMemoryEntries(trimmed);

  const result = blueprint.buildPersonalWiki(entries, outDir, { title: 'Personal Memory Wiki' });

  process.stdout.write(`[wiki] ✅ Rebuilt personal memory wiki\n`);
  process.stdout.write(`[wiki]    Entries : ${result.totalEntries} (of ${rawEntries.length} total in memory)\n`);
  process.stdout.write(`[wiki]    Days    : ${result.days.length}\n`);
  process.stdout.write(`[wiki]    Index   : ${result.indexFile}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => { process.stderr.write(`[wiki] fatal: ${err && err.stack || err}\n`); process.exit(2); },
);
