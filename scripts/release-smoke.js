#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const zipPath = path.resolve(process.argv[2] || '');
const manifestPath = process.argv[3] ? path.resolve(process.argv[3]) : '';

async function main() {
  if (!zipPath || !fs.existsSync(zipPath)) throw new Error('Usage: node scripts/release-smoke.js <release-zip> [release-manifest.json]');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-'));
  try {
    extractZip(zipPath, workDir);
    assertFile(workDir, 'package.json');
    assertFile(workDir, 'package-lock.json');
    assertFile(workDir, 'dist/cli/index.js');
    assertFile(workDir, 'dist/web/server.js');
    assertFile(workDir, 'scripts/release-notes.js');
    assertFile(workDir, 'scripts/telegram-smoke.js');
    assertFile(workDir, 'scripts/audit-triage.js');
    assertFile(workDir, 'scripts/lean-gemma-tool-probe.js');
    assertFile(workDir, 'scripts/bounded-news-smoke.js');
    assertFile(workDir, 'ui/index.html');
    assertFile(workDir, 'start.bat');
    assertFile(workDir, 'release-provenance.json');
    assertFileContains(workDir, 'start.bat', 'npm ci');
    assertReleaseProvenance(workDir);
    if (manifestPath) assertReleaseManifest(manifestPath, zipPath);

    run('npm', ['ci'], workDir);
    run('node', ['dist/cli/index.js', '--help'], workDir);
    await assertCompiledServerStarts(workDir);

    console.log(JSON.stringify({ ok: true, zip: zipPath, checked: workDir }, null, 2));
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (error) {
      console.warn(`Release smoke cleanup skipped: ${error.message || error}`);
    }
  }
}

function assertReleaseManifest(filePath, assetPath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing release manifest: ${filePath}`);
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const assetStats = fs.statSync(assetPath);
  const manifestName = path.basename(filePath);
  if (manifest.assetName !== path.basename(assetPath)) throw new Error('Release manifest assetName does not match the release archive.');
  if (manifest.manifestName !== manifestName) throw new Error('Release manifest manifestName does not match the manifest file name.');
  if (manifest.assetSize !== assetStats.size) throw new Error('Release manifest assetSize does not match the release archive.');
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || ''))) throw new Error('Release manifest version is missing or invalid.');
  if (!/^[a-f0-9]{40}$/i.test(String(manifest.commit || ''))) throw new Error('Release manifest commit is missing or invalid.');
  if (!/^https:\/\/github\.com\/.+\/releases\/tag\/v\d+\.\d+\.\d+/.test(String(manifest.releaseUrl || ''))) throw new Error('Release manifest releaseUrl is missing or invalid.');
  if (Number.isNaN(Date.parse(String(manifest.generatedAt || '')))) throw new Error('Release manifest generatedAt is missing or invalid.');
  const actualSha = cryptoHash(assetPath);
  if (!/^[a-f0-9]{64}$/i.test(String(manifest.assetSha256 || ''))) throw new Error('Release manifest assetSha256 is missing or invalid.');
  if (manifest.assetSha256 !== actualSha) throw new Error('Release manifest SHA-256 does not match the release archive.');
}

function cryptoHash(filePath) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertReleaseProvenance(root) {
  const filePath = path.join(root, 'release-provenance.json');
  const provenance = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!provenance.version) throw new Error('release-provenance.json is missing version.');
  if (!provenance.assetName) throw new Error('release-provenance.json is missing assetName.');
}

function extractZip(source, destination) {
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quotePowerShell(source)} -DestinationPath ${quotePowerShell(destination)} -Force`], process.cwd());
    return;
  }
  run('unzip', ['-q', source, '-d', destination], process.cwd());
}

function assertFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`Missing release file: ${relativePath}`);
}

function assertFileContains(root, relativePath, expected) {
  const filePath = path.join(root, relativePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes(expected)) throw new Error(`Release file ${relativePath} did not contain expected bootstrapper text.`);
}

function run(command, args, cwd) {
  const invocation = process.platform === 'win32' && command === 'npm'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...args].map(quoteCmdArg).join(' ')] }
    : { command, args };
  const result = spawnSync(invocation.command, invocation.args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

function quoteCmdArg(value) {
  const text = String(value);
  return /[\s&()^|<>]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

async function assertCompiledServerStarts(cwd) {
  const port = 4329;
  const child = spawn('node', ['dist/web/server.js'], {
    cwd,
    env: { ...process.env, PORT: String(port), NO_OPEN: '1', HARNESS_DISABLE_STARTUP_CONNECTORS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, child, () => output);
  } finally {
    await stopChild(child);
  }
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  });
}

async function waitForServer(url, child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}: ${getOutput()}`);
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && body.includes('Ollama Agent Harness')) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for compiled server: ${getOutput()}`);
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
