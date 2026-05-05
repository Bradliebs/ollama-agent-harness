#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function main() {
  const version = `v${readPackageVersion()}`;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-dry-run-'));
  const stagingDir = path.join(outputDir, 'staging');
  const assetPath = path.join(outputDir, `ollama-agent-harness-${version}.zip`);
  const provenancePath = path.join(outputDir, 'release-provenance.json');
  const notesPath = path.join(outputDir, 'release-notes.md');
  const manifestPath = path.join(outputDir, `${path.basename(assetPath)}.sha256.json`);
  const commit = gitCommit();
  const repository = inferRepository();

  runNpm(['run', 'build']);
  stageReleaseContents(stagingDir, version, commit, repository);
  createZip(stagingDir, assetPath);
  fs.copyFileSync(path.join(stagingDir, 'release-provenance.json'), provenancePath);
  runNpm(['run', 'verify:versions']);
  runNpm(['run', 'release:manifest', '--', '--version', version, '--asset', assetPath, '--commit', commit, '--repository', repository, '--output', manifestPath]);
  runNode(['scripts/release-smoke.js', assetPath, manifestPath]);
  runNpm(['run', 'release:notes', '--', '--version', version, '--asset', assetPath, '--commit', commit, '--output', notesPath]);

  console.log(JSON.stringify({ ok: true, outputDir, files: listOutputs(outputDir) }, null, 2));
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;
}

function inferRepository() {
  try {
    const provenance = JSON.parse(fs.readFileSync(path.join(root, 'release-provenance.json'), 'utf-8'));
    const match = String(provenance.releaseUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//);
    if (match) return match[1];
  } catch {}
  return 'Bradliebs/ollama-agent-harness';
}

function stageReleaseContents(stagingDir, version, commit, repository) {
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const directory of ['dist', 'ui', 'scripts']) {
    copyRequired(path.join(root, directory), path.join(stagingDir, directory));
  }
  for (const file of ['package.json', 'package-lock.json', 'README.md', 'start.bat']) {
    copyRequired(path.join(root, file), path.join(stagingDir, file));
  }
  fs.writeFileSync(path.join(stagingDir, 'release-provenance.json'), JSON.stringify({
    version: version.replace(/^v/, ''),
    commit,
    assetName: `ollama-agent-harness-${version}.zip`,
    releaseUrl: `https://github.com/${repository}/releases/tag/${version}`,
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf-8');
}

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Release dry-run missing required input: ${path.relative(root, source)}`);
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

function gitCommit() {
  const result = run('git', ['rev-parse', 'HEAD'], root);
  return result.stdout.trim();
}

function runNode(args) {
  return run(process.execPath, args);
}

function runNpm(args) {
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/d', '/s', '/c', ['npm', ...args].map(quoteCmdArg).join(' ')]);
  }
  return run('npm', args);
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

function listOutputs(outputDir) {
  return fs.readdirSync(outputDir)
    .filter((name) => name !== 'staging')
    .map((name) => ({ name, bytes: fs.statSync(path.join(outputDir, name)).size }));
}

function quoteCmdArg(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
