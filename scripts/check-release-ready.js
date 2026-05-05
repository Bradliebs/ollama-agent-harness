#!/usr/bin/env node
// Single-command release-readiness pre-flight.
//
// Runs the same gates that CI and the Release workflow will hit, plus a
// working-tree cleanliness check, so a human can verify "ready to tag" in
// one command. Read-only; never mutates the repo.
//
// Usage:
//   node scripts/check-release-ready.js
//
// Exit code is 0 when everything passes, 1 otherwise. Each check prints a
// pass/fail line so a failure is easy to spot in scrollback.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failures = 0;

function check(name, fn) {
  try {
    const detail = fn();
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures++;
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}\n     ${msg.split('\n')[0]}`);
  }
}

function npmRun(script) {
  // Use cmd.exe on Windows to avoid Node DEP0190 from `shell: true` arg arrays.
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', `npm run ${script}`], { cwd: root, stdio: 'pipe' });
  } else {
    execFileSync('npm', ['run', script], { cwd: root, stdio: 'pipe' });
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

console.log(`\nRelease readiness for v${pkg.version}\n`);

check('working tree is clean', () => {
  const status = git('status', '--porcelain');
  if (status) throw new Error(`uncommitted changes:\n${status}`);
});

check('local HEAD is up to date with origin', () => {
  try { git('fetch', '--quiet', 'origin'); } catch { /* offline OK */ }
  const local = git('rev-parse', 'HEAD');
  let remote;
  try { remote = git('rev-parse', '@{u}'); } catch { return 'no upstream tracking'; }
  if (local !== remote) throw new Error(`HEAD ${local.slice(0, 8)} differs from upstream ${remote.slice(0, 8)}`);
});

check('CHANGELOG has a section for the current version', () => npmRun('verify:changelog'));
check('all version-bearing files agree (verify:versions via dry-run)', () => npmRun('release:dry-run'));

check('typecheck passes', () => npmRun('typecheck'));

const tag = `v${pkg.version}`;
check(`tag ${tag} does not yet exist`, () => {
  try { git('rev-parse', tag); throw new Error(`${tag} already exists`); } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/already exists/.test(msg)) throw error;
    // git rev-parse failure means the tag is absent; that is what we want.
  }
});

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed. Resolve before tagging.`);
  process.exit(1);
}
console.log(`Ready to tag ${tag}.`);
console.log(`  git tag -a ${tag} -m "${tag}"`);
console.log(`  git push origin ${tag}`);
