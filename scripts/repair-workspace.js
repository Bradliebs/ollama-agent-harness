#!/usr/bin/env node
// Repair a live harness workspace polluted by test runs.
//
// Before 2026-07-10, Jest inherited a user-level HARNESS_PROJECT_DIR and wrote
// fixtures into the real workspace: SOUL.md was replaced with test text, test
// capability grants landed in settings.json, and "test-model" entries skewed
// model-reliability.json and synthesis-stats.json. This script reverses that.
//
// Usage:
//   node scripts/repair-workspace.js [--dir <workspace>]           dry run
//   node scripts/repair-workspace.js [--dir <workspace>] --apply   apply
// The workspace defaults to HARNESS_PROJECT_DIR. Stop the server before
// applying; it holds settings in memory and would overwrite the repair.

const fs = require('fs');
const net = require('net');
const path = require('path');

const SOUL_FIXTURE = 'Temporary import soul text for regression test.';
const MIN_SOUL_CHARS = 200;
const TEST_GRANT_REASON = /\btest\b/i;
const TEST_MODEL_KEY = /^test-model(::|$)/;
const TEST_DEBUG_LOG_PATH = '.harness/test-model-debug.jsonl';
const DEFAULT_DEBUG_LOG_PATH = '.harness/model-debug.jsonl';
const KNOWLEDGE_COMPACT_BYTES = 20 * 1024 * 1024;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function isFixtureSoul(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed === '' || trimmed === SOUL_FIXTURE;
}

/** Newest identity history snapshot holding a real (non-fixture) SOUL.md. */
function findSoulSnapshot(identityDir) {
  const historyDir = path.join(identityDir, 'history');
  if (!fs.existsSync(historyDir)) return null;
  const dirs = fs.readdirSync(historyDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of dirs) {
    const file = path.join(historyDir, name, 'SOUL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    if (!isFixtureSoul(text) && text.trim().length >= MIN_SOUL_CHARS) return { file, snapshot: name, text };
  }
  return null;
}

/** Work out every change without touching disk. */
function planRepair(workspace) {
  const harness = path.join(workspace, '.harness');
  if (!fs.existsSync(harness)) throw new Error(`No .harness directory in ${workspace}`);
  const actions = [];

  const identityDir = path.join(harness, 'identity');
  const soulPath = path.join(identityDir, 'SOUL.md');
  const currentSoul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : '';
  if (isFixtureSoul(currentSoul)) {
    const snapshot = findSoulSnapshot(identityDir);
    if (snapshot) {
      actions.push({ kind: 'restore-soul', file: soulPath, from: snapshot.file, snapshot: snapshot.snapshot, text: snapshot.text, previous: currentSoul });
    } else {
      actions.push({ kind: 'warn', message: 'SOUL.md is the test fixture but no usable snapshot exists in identity/history.' });
    }
  }

  const settingsPath = path.join(harness, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    const grants = Array.isArray(settings.capabilityGrants) ? settings.capabilityGrants : [];
    const testGrants = grants.filter((grant) => TEST_GRANT_REASON.test(String(grant?.reason ?? '')));
    const debugPathIsTest = settings.modelDebugLog?.path === TEST_DEBUG_LOG_PATH;
    if (testGrants.length > 0 || debugPathIsTest) {
      const next = { ...settings };
      if (testGrants.length > 0) next.capabilityGrants = grants.filter((grant) => !testGrants.includes(grant));
      if (debugPathIsTest) next.modelDebugLog = { ...settings.modelDebugLog, path: DEFAULT_DEBUG_LOG_PATH };
      actions.push({
        kind: 'write-json',
        file: settingsPath,
        data: next,
        summary: [
          testGrants.length > 0 ? `remove ${testGrants.length} test capability grant(s): ${[...new Set(testGrants.map((g) => g.reason))].join('; ')}` : null,
          debugPathIsTest ? `reset modelDebugLog.path ${TEST_DEBUG_LOG_PATH} -> ${DEFAULT_DEBUG_LOG_PATH}` : null,
        ].filter(Boolean).join(', '),
      });
    }
  }

  for (const name of ['model-reliability.json', 'synthesis-stats.json']) {
    const file = path.join(harness, name);
    if (!fs.existsSync(file)) continue;
    const data = readJson(file);
    const testKeys = Object.keys(data).filter((key) => TEST_MODEL_KEY.test(key));
    if (testKeys.length === 0) continue;
    const next = Object.fromEntries(Object.entries(data).filter(([key]) => !TEST_MODEL_KEY.test(key)));
    actions.push({ kind: 'write-json', file, data: next, summary: `remove test stats keys: ${testKeys.join(', ')}` });
  }

  // The ambient watcher used to re-append the same file entity every few
  // seconds; merge duplicates once the log is large.
  const knowledgePath = path.join(harness, 'jarvis', 'knowledge.jsonl');
  if (fs.existsSync(knowledgePath) && fs.statSync(knowledgePath).size >= KNOWLEDGE_COMPACT_BYTES) {
    actions.push({ kind: 'compact-knowledge', file: knowledgePath, bytes: fs.statSync(knowledgePath).size });
  }

  return actions;
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function loadKnowledgeCompactor() {
  const compiled = path.join(__dirname, '..', 'dist', 'jarvis', 'knowledgeGraphCompaction.js');
  if (!fs.existsSync(compiled)) throw new Error('Knowledge graph compaction needs a build. Run npm run build first.');
  return require(compiled).compactKnowledgeGraph;
}

/** Back up every file an action touches, then apply. Returns the backup dir. */
async function applyRepair(workspace, actions, now = new Date(), options = {}) {
  const harness = path.join(workspace, '.harness');
  const stamp = timestamp(now);
  const backupDir = path.join(harness, 'snapshots', `repair-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const action of actions) {
    if (action.kind === 'warn' || !fs.existsSync(action.file)) continue;
    const rel = path.relative(harness, action.file);
    fs.mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
    fs.copyFileSync(action.file, path.join(backupDir, rel));
  }
  for (const action of actions) {
    if (action.kind === 'restore-soul') {
      // Match identityProposals' convention: snapshot before changing SOUL.md.
      const historyDir = path.join(path.dirname(action.file), 'history', `${stamp}-pre-repair`);
      fs.mkdirSync(historyDir, { recursive: true });
      fs.writeFileSync(path.join(historyDir, 'SOUL.md'), action.previous, 'utf-8');
      fs.writeFileSync(action.file, action.text, 'utf-8');
    } else if (action.kind === 'write-json') {
      const tmp = `${action.file}.repair-tmp`;
      fs.writeFileSync(tmp, JSON.stringify(action.data, null, 2), 'utf-8');
      fs.renameSync(tmp, action.file);
    } else if (action.kind === 'compact-knowledge') {
      const compact = options.compactKnowledgeGraph || loadKnowledgeCompactor();
      action.stats = await compact(workspace);
    }
  }
  return backupDir;
}

function describe(action) {
  if (action.kind === 'restore-soul') return `restore ${action.file} from identity/history/${action.snapshot} (${action.text.length} chars)`;
  if (action.kind === 'write-json') return `${action.file}: ${action.summary}`;
  if (action.kind === 'compact-knowledge') return `compact ${action.file} (${(action.bytes / 1024 / 1024).toFixed(1)} MB of repeated entity records)`;
  return `WARNING: ${action.message}`;
}

function isPortOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function parseArgs(argv) {
  const args = { apply: argv.includes('--apply'), force: argv.includes('--force'), dir: process.env.HARNESS_PROJECT_DIR };
  const dirIndex = argv.indexOf('--dir');
  if (dirIndex >= 0 && argv[dirIndex + 1]) args.dir = argv[dirIndex + 1];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) throw new Error('No workspace given. Pass --dir <workspace> or set HARNESS_PROJECT_DIR.');
  const workspace = path.resolve(args.dir);
  const actions = planRepair(workspace);
  console.log(`Workspace: ${workspace}`);
  if (actions.length === 0) {
    console.log('Nothing to repair.');
    return;
  }
  for (const action of actions) console.log(`- ${describe(action)}`);
  if (!args.apply) {
    console.log('\nDry run only. Re-run with --apply to make these changes (a backup is taken first).');
    return;
  }
  const ports = process.env.PORT ? [Number(process.env.PORT)] : [4300, 3000];
  for (const port of ports) {
    if (!args.force && await isPortOpen(port)) {
      throw new Error(`Something is listening on port ${port}. Stop the harness server first (it would overwrite settings.json), or pass --force if that is not the harness.`);
    }
  }
  const backupDir = await applyRepair(workspace, actions);
  for (const action of actions) {
    if (action.kind === 'compact-knowledge' && action.stats) console.log(`Knowledge graph: ${action.stats.before} records -> ${action.stats.after}`);
  }
  console.log(`\nApplied. Backup of the original files: ${backupDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { planRepair, applyRepair, findSoulSnapshot, isFixtureSoul, SOUL_FIXTURE };
