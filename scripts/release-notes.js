#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = parseArgs(process.argv.slice(2));
const version = args.version || process.env.GITHUB_REF_NAME || readPackageVersion();
const output = path.resolve(args.output || path.join('release', 'release-notes.md'));
const changesDir = path.resolve(args.changesDir || path.join('.copilot-tracking', 'changes'));

function main() {
  const entries = readChangeLogs(changesDir);
  const lines = [
    `# Ollama Agent Harness ${version}`,
    '',
  ];

  if (entries.length > 0) {
    lines.push('## Changes', '');
    for (const entry of entries.slice(0, 8)) {
      lines.push(`### ${entry.title}`, '');
      if (entry.summary) lines.push(entry.summary, '');
      for (const item of entry.releaseItems.slice(0, 5)) lines.push(`* ${item}`);
      if (entry.releaseItems.length > 0) lines.push('');
    }
  } else {
    const fallback = gitSummary();
    lines.push('## Changes', '', fallback || 'Validated release from the current repository state.', '');
  }

  lines.push('## Validation', '', '* Typecheck, tests, build, and release archive smoke are expected to pass before publishing.', '');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, lines.join('\n'), 'utf-8');
  console.log(JSON.stringify({ ok: true, output, changes: entries.length }, null, 2));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--version') parsed.version = values[++index];
    else if (value === '--output') parsed.output = values[++index];
    else if (value === '--changes-dir') parsed.changesDir = values[++index];
  }
  return parsed;
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    return `v${pkg.version}`;
  } catch {
    return 'current release';
  }
}

function readChangeLogs(root) {
  if (!fs.existsSync(root)) return [];
  const files = walk(root).filter((file) => file.endsWith('-changes.md'));
  return files
    .map((file) => ({ file, stat: fs.statSync(file), content: fs.readFileSync(file, 'utf-8') }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map((entry) => parseChangeLog(entry.file, entry.content));
}

function walk(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}

function parseChangeLog(file, content) {
  const title = firstMatch(content, /^#\s+(.+)$/m) || path.basename(file, '.md');
  const summary = section(content, 'Summary').split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
  const release = section(content, 'Release Summary');
  const modified = section(content, 'Modified');
  const added = section(content, 'Added');
  return {
    title,
    summary,
    releaseItems: bulletItems(release).concat(bulletItems(added), bulletItems(modified)),
  };
}

function section(content, heading) {
  const pattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^## |\\z)`, 'm');
  return firstMatch(content, pattern) || '';
}

function bulletItems(content) {
  return content.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('* '))
    .map((line) => line.slice(2).trim());
}

function firstMatch(content, pattern) {
  const match = content.match(pattern);
  return match ? match[1].trim() : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gitSummary() {
  const result = spawnSync('git', ['log', '-1', '--pretty=format:%s'], { encoding: 'utf-8' });
  return result.status === 0 && result.stdout.trim() ? `Latest commit: ${result.stdout.trim()}` : '';
}

main();
