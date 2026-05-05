#!/usr/bin/env node
// Fails when package.json version has no matching `## ... v<version>` section
// in CHANGELOG.md. Wired into CI to prevent silently shipping a tag whose
// release notes would be empty.
//
// Usage:
//   node scripts/check-changelog-version.js

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = pkg.version;
const changelogPath = path.join(root, 'CHANGELOG.md');

if (!fs.existsSync(changelogPath)) {
  console.error('CHANGELOG.md is missing.');
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, 'utf-8');
// Match `## ... v0.3.26` or `## v0.3.26` headings.
const escaped = version.replace(/\./g, '\\.');
const re = new RegExp(`^##\\s+.*\\bv${escaped}\\b`, 'm');
if (!re.test(changelog)) {
  console.error(`CHANGELOG.md is missing a section for v${version}.`);
  console.error('Add a `## Ollama Agent Harness v' + version + '` section before tagging.');
  process.exit(1);
}

console.log(`ok: CHANGELOG.md has a v${version} section.`);
