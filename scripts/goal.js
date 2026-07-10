#!/usr/bin/env node
/**
 * scripts/goal.js — CLI for the goal expander.
 *
 * Takes a high-level intent and appends an expanded multi-task block to
 * IMPLEMENTATION_PLAN.md so the autonomy loop (cookbook/task-loop.ts) can
 * pick it up on its next iteration.
 *
 * Usage:
 *   node scripts/goal.js "Build a wiki from D:\\big.pdf"
 *   node scripts/goal.js --dry "Research https://acme.example.com tech stack"
 *   node scripts/goal.js --plan custom-plan.md "Set up a 9am morning prompt"
 *
 * Exit codes:
 *   0  appended (or printed in dry mode) successfully
 *   1  invalid arguments
 *   2  no tasks produced for the intent (refused to mutate the plan)
 */

'use strict';

const { existsSync, readFileSync, appendFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

function parseArgs(argv) {
  const args = { dry: false, plan: 'IMPLEMENTATION_PLAN.md', intent: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry' || a === '-n') args.dry = true;
    else if (a === '--plan' || a === '-p') args.plan = argv[++i];
    else if (a === '--help' || a === '-h') return { help: true };
    else rest.push(a);
  }
  args.intent = rest.join(' ').trim();
  return args;
}

function usage() {
  process.stdout.write(
    'Usage: node scripts/goal.js [--dry] [--plan FILE] "<intent>"\n' +
    '\n' +
    'Options:\n' +
    '  --dry, -n           Print the expanded tasks without modifying the plan\n' +
    '  --plan, -p FILE     Plan file to append to (default: IMPLEMENTATION_PLAN.md)\n' +
    '  --help, -h          Show this message\n',
  );
}

function loadExistingIds(planPath) {
  if (!existsSync(planPath)) return [];
  const ids = [];
  const text = readFileSync(planPath, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^- \[.\] (\S+)\s+[—-]/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (!args.intent) { usage(); return 1; }

  // ts-node is a runtime dep for the harness; this script is invoked
  // through it (or after `tsc`) so we can import the TS module directly.
  let expander;
  try {
    expander = require('../src/services/goalExpander');
  } catch (err) {
    // Fallback for environments that pre-built to dist/
    expander = require('../dist/services/goalExpander');
  }
  const { expandGoal, renderTasksAsPlanMarkdown } = expander;

  const planPath = resolve(args.plan);
  const existingIds = loadExistingIds(planPath);
  const result = expandGoal(args.intent, { existingIds });

  if (result.tasks.length === 0) {
    process.stderr.write(`[goal] No tasks produced for intent: ${args.intent}\n`);
    return 2;
  }

  const block = renderTasksAsPlanMarkdown(result.tasks);
  process.stdout.write(`[goal] Detected intent: ${result.shape}\n`);
  process.stdout.write(`[goal] ${result.rationale}\n`);
  process.stdout.write(`[goal] Emitting ${result.tasks.length} task(s):\n\n`);
  process.stdout.write(block);

  if (args.dry) {
    process.stdout.write('\n[goal] --dry: plan not modified.\n');
    return 0;
  }

  if (!existsSync(planPath)) {
    writeFileSync(planPath, '# Implementation Plan\n\n' + block, 'utf-8');
    process.stdout.write(`\n[goal] Created ${args.plan} with ${result.tasks.length} task(s).\n`);
  } else {
    const existing = readFileSync(planPath, 'utf-8');
    const sep = existing.endsWith('\n') ? '' : '\n';
    appendFileSync(planPath, sep + block, 'utf-8');
    process.stdout.write(`\n[goal] Appended ${result.tasks.length} task(s) to ${args.plan}.\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => { process.stderr.write(`[goal] fatal: ${err && err.stack || err}\n`); process.exit(99); },
);
