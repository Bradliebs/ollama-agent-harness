#!/usr/bin/env node
// Single-source version bump for the harness release pipeline.
//
// Updates package.json (and package-lock.json), the NSIS installer metadata,
// and release-provenance.json to a new semver version. Stops short of
// committing or tagging so the user retains control over publication.
//
// Usage:
//   node scripts/bump-version.js <new-version> [--commit <sha>] [--repository <owner/repo>]
//
// Examples:
//   node scripts/bump-version.js 0.3.27
//   node scripts/bump-version.js 0.3.27 --commit HEAD --repository Bradliebs/ollama-agent-harness

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--commit') args.commit = argv[++i];
    else if (token === '--repository') args.repository = argv[++i];
    else if (token === '--built-at') args.builtAt = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
    else args._.push(token);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/bump-version.js <new-version> [--commit <sha>] [--repository <owner/repo>] [--built-at <iso>]\n\nUpdates package.json, installer NSIS metadata, and release-provenance.json to <new-version>.\nDoes not commit, tag, or push.`);
}

function semverOk(v) {
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v);
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function write(filePath, contents) {
  fs.writeFileSync(filePath, contents, 'utf-8');
}

function bumpInstaller(root, newVersion) {
  const installerPath = path.join(root, 'installer', 'harness-installer.nsi');
  if (!fs.existsSync(installerPath)) return false;
  const original = read(installerPath);
  let next = original;
  next = next.replace(/VIProductVersion\s+"[^"]+"/g, `VIProductVersion "${newVersion}.0"`);
  next = next.replace(/VIAddVersionKey\s+"FileVersion"\s+"[^"]+"/g, `VIAddVersionKey "FileVersion" "${newVersion}"`);
  next = next.replace(/"DisplayVersion"\s+"[^"]+"/g, `"DisplayVersion" "${newVersion}"`);
  if (next === original) return false;
  write(installerPath, next);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const newVersion = args._[0];
  if (!semverOk(newVersion)) {
    console.error(`Invalid version: ${newVersion}`);
    process.exit(1);
  }

  const root = path.resolve(__dirname, '..');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(read(pkgPath));
  const prev = pkg.version;
  pkg.version = newVersion;
  write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Sync package-lock.json without touching node_modules.
  // Use cmd.exe /c on Windows to avoid DEP0190 (shell:true with arg arrays).
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm install --package-lock-only --ignore-scripts'], { cwd: root, stdio: 'inherit' });
  } else {
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
  }

  const installerUpdated = bumpInstaller(root, newVersion);

  const commit = args.commit && args.commit !== 'HEAD'
    ? args.commit
    : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
  const repository = args.repository || 'Bradliebs/ollama-agent-harness';
  const builtAt = args.builtAt || new Date().toISOString();

  execFileSync('node', [
    path.join('scripts', 'generate-release-provenance.js'),
    '--write',
    '--version', `v${newVersion}`,
    '--commit', commit,
    '--repository', repository,
    '--built-at', builtAt,
  ], { cwd: root, stdio: 'inherit' });

  console.log(JSON.stringify({
    ok: true,
    previous: prev,
    next: newVersion,
    installer: installerUpdated,
    commit,
    repository,
    builtAt,
  }, null, 2));
}

main();
