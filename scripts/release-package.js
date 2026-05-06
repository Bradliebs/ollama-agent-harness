#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const RELEASE_ONLY_ENTRIES = ['scripts', 'package.json', 'package-lock.json', 'release-provenance.json'];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = String(args.version || '').replace(/^v?/, 'v');
  const assetPath = args.asset ? path.resolve(args.asset) : '';
  if (!version || version === 'v' || !assetPath) {
    throw new Error('Usage: node scripts/release-package.js --version <vX.Y.Z> --commit <sha> --repository <owner/repo> --asset <release.zip>');
  }

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-package-'));
  const stagingDir = path.join(outputDir, 'staging');
  stageReleaseContents({
    stagingDir,
    version,
    commit: args.commit || '',
    repository: args.repository || inferRepository(),
    generatedAt: args.builtAt || new Date().toISOString(),
  });
  createZip(stagingDir, assetPath);
  console.log(JSON.stringify({ ok: true, assetPath, entries: releaseArchiveEntries() }, null, 2));
}

function releaseArchiveEntries(projectRoot = root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  const entries = new Set(RELEASE_ONLY_ENTRIES);
  for (const entry of Array.isArray(packageJson.files) ? packageJson.files : []) {
    const normalized = normalizeEntry(entry);
    if (normalized && !normalized.includes('*')) entries.add(normalized);
  }
  return Array.from(entries).sort();
}

function stageReleaseContents({ stagingDir, version, commit, repository, generatedAt }) {
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const entry of releaseArchiveEntries()) {
    if (entry === 'release-provenance.json') continue;
    copyRequired(path.join(root, entry), path.join(stagingDir, entry));
  }
  fs.writeFileSync(path.join(stagingDir, 'release-provenance.json'), JSON.stringify({
    version: version.replace(/^v/, ''),
    commit,
    assetName: `ollama-agent-harness-${version}.zip`,
    releaseUrl: `https://github.com/${repository}/releases/tag/${version}`,
    generatedAt,
  }, null, 2) + '\n', 'utf-8');
}

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Release package missing required input: ${path.relative(root, source)}`);
  fs.cpSync(source, destination, { recursive: true });
}

function createZip(stagingDir, assetPath) {
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path ${quotePowerShell(path.join(stagingDir, '*'))} -DestinationPath ${quotePowerShell(assetPath)} -Force`], root);
    return;
  }
  run('zip', ['-r', assetPath, '.'], stagingDir);
}

function inferRepository() {
  try {
    const provenance = JSON.parse(fs.readFileSync(path.join(root, 'release-provenance.json'), 'utf-8'));
    const match = String(provenance.releaseUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//);
    if (match) return match[1];
  } catch {}
  return 'Bradliebs/ollama-agent-harness';
}

function normalizeEntry(entry) {
  return String(entry || '').replace(/\\/g, '/').replace(/\/$/, '').trim();
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    parsed[value.slice(2)] = values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : 'true';
  }
  return parsed;
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { createZip, releaseArchiveEntries, stageReleaseContents };