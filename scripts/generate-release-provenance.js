#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const provenance = generateReleaseProvenance({
    root,
    existingPath: path.join(root, 'release-provenance.json'),
    version: args.version,
    commit: args.commit,
    repository: args.repository,
    builtAt: args.builtAt,
  });
  const json = JSON.stringify(provenance, null, 2) + '\n';
  if (args.write) {
    fs.writeFileSync(path.join(root, 'release-provenance.json'), json, 'utf-8');
    console.log('release-provenance.json regenerated.');
  } else {
    process.stdout.write(json);
  }
}

function generateReleaseProvenance(options = {}) {
  const projectRoot = options.root || root;
  const existingPath = options.existingPath || path.join(projectRoot, 'release-provenance.json');
  const packageJson = readJson(path.join(projectRoot, 'package.json'));
  const version = String(options.version || packageJson.version || '').replace(/^v/, '').trim();
  const existing = fs.existsSync(existingPath) ? readJson(existingPath) : {};
  const repository = options.repository || inferRepository(existing.releaseUrl, packageJson.repository);
  const tag = `v${version}`;
  return {
    assetName: `ollama-agent-harness-${tag}.zip`,
    commit: String(options.commit || existing.commit || gitCommit(projectRoot) || '').trim(),
    version,
    builtAt: String(options.builtAt || existing.builtAt || new Date().toISOString()),
    releaseUrl: repository ? `https://github.com/${repository}/releases/tag/${tag}` : String(existing.releaseUrl || ''),
  };
}

function inferRepository(existingReleaseUrl, repository) {
  const existingMatch = String(existingReleaseUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//);
  if (existingMatch) return existingMatch[1];
  if (typeof repository === 'string') return repository.replace(/^git\+/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (repository && typeof repository.url === 'string') return inferRepository('', repository.url);
  return '';
}

function gitCommit(projectRoot) {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function parseArgs(values) {
  const parsed = { write: values.includes('--write') };
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith('--') || value === '--write') continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = values[i + 1] && !values[i + 1].startsWith('--') ? values[++i] : 'true';
  }
  return parsed;
}

module.exports = { generateReleaseProvenance };
