#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const registryInstallKey = 'HKCU\\Software\\OllamaAgentHarness';
const registryUninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OllamaAgentHarness';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (process.platform !== 'win32') throw new Error('Installer smoke is Windows-only because the Harness installer is an NSIS executable.');

  const installerPath = path.resolve(options.installerPath || '');
  if (!installerPath || !fs.existsSync(installerPath)) {
    throw new Error('Usage: node scripts/installer-smoke.js <Harness-Setup.exe> [--install-dir <path>] [--keep]');
  }

  const installDir = options.installDir
    ? path.resolve(options.installDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-smoke-'));

  assertNoExistingFootprint(installDir);

  let keepInstall = options.keep;
  try {
    run(installerPath, ['/S', `/D=${installDir}`], process.cwd(), 20 * 60 * 1000);
    await waitFor(() => fs.existsSync(path.join(installDir, 'uninstall.exe')), 30_000, 'Timed out waiting for installer output.');

    const installed = verifyInstall(installDir);
    await verifyServerStarts(installDir);

    if (!keepInstall) await uninstallAndVerify(installDir);

    console.log(JSON.stringify({ ok: true, installer: installerPath, installDir, installed, kept: keepInstall }, null, 2));
  } catch (error) {
    keepInstall = true;
    throw error;
  } finally {
    if (!keepInstall) cleanupInstallDir(installDir);
  }
}

function parseArgs(args) {
  const options = { help: false, keep: false, installerPath: '', installDir: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--install-dir') {
      index += 1;
      options.installDir = args[index] || '';
    } else if (!options.installerPath) options.installerPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/installer-smoke.js <Harness-Setup.exe> [--install-dir <path>] [--keep]

Installs the NSIS Harness installer silently into a disposable directory,
checks the installed CLI, registry metadata, shortcuts, and web server startup,
then uninstalls and verifies cleanup.

The smoke refuses to run if an existing Harness install footprint is present.`);
}

function assertNoExistingFootprint(installDir) {
  const conflicts = [];
  if (fs.existsSync(installDir) && fs.readdirSync(installDir).length > 0) conflicts.push(`non-empty install dir: ${installDir}`);
  if (regValue(registryInstallKey, 'InstallDir')) conflicts.push(registryInstallKey);
  if (regValue(registryUninstallKey, 'DisplayVersion')) conflicts.push(registryUninstallKey);
  if (fs.existsSync(desktopShortcutPath())) conflicts.push(desktopShortcutPath());
  if (fs.existsSync(startMenuDirPath())) conflicts.push(startMenuDirPath());
  if (conflicts.length > 0) {
    throw new Error(`Refusing to run installer smoke over an existing Harness footprint: ${conflicts.join(', ')}`);
  }
}

function verifyInstall(installDir) {
  assertFile(installDir, 'package.json');
  assertFile(installDir, 'package-lock.json');
  assertFile(installDir, 'dist/cli/index.js');
  assertFile(installDir, 'dist/web/server.js');
  assertFile(installDir, 'ui/index.html');
  assertFile(installDir, 'node_modules');
  assertFile(installDir, 'uninstall.exe');

  const packageJson = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf-8'));
  if (!/^\d+\.\d+\.\d+$/.test(String(packageJson.version || ''))) throw new Error('Installed package version is missing or invalid.');

  const help = run(process.execPath, [path.join(installDir, 'dist/cli/index.js'), '--help'], installDir, 60_000, true);
  if (!help.stdout.includes('Ollama Agent Harness - local-first agentic coding tool')) throw new Error('Installed CLI help did not render expected text.');

  const installRegDir = regValue(registryInstallKey, 'InstallDir');
  if (!samePath(installRegDir, installDir)) throw new Error(`InstallDir registry value did not match smoke directory: ${installRegDir || '<missing>'}`);

  const displayVersion = regValue(registryUninstallKey, 'DisplayVersion');
  if (displayVersion !== packageJson.version) throw new Error(`DisplayVersion registry value did not match package version: ${displayVersion || '<missing>'}`);

  if (!fs.existsSync(desktopShortcutPath())) throw new Error('Desktop shortcut was not created.');
  if (!fs.existsSync(startMenuDirPath())) throw new Error('Start Menu folder was not created.');

  return { version: packageJson.version, installRegDir, displayVersion };
}

async function verifyServerStarts(installDir) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['dist/web/server.js'], {
    cwd: installDir,
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
    cleanupRuntimeState(installDir);
  }
}

async function uninstallAndVerify(installDir) {
  const uninstaller = path.join(installDir, 'uninstall.exe');
  if (!fs.existsSync(uninstaller)) throw new Error('Missing uninstaller after smoke install.');
  run(uninstaller, ['/S'], os.tmpdir(), 5 * 60 * 1000, true);
  await waitFor(() => !hasInstallFootprint(installDir), 90_000, 'Timed out waiting for installer smoke cleanup.');
}

function hasInstallFootprint(installDir) {
  return fs.existsSync(installDir)
    || Boolean(regValue(registryInstallKey, 'InstallDir'))
    || Boolean(regValue(registryUninstallKey, 'DisplayVersion'))
    || fs.existsSync(desktopShortcutPath())
    || fs.existsSync(startMenuDirPath());
}

function assertFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`Missing installed file: ${relativePath}`);
}

function run(command, args, cwd, timeout, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: capture ? 'pipe' : 'inherit',
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}. ${detail}`.trim());
  }
  return result;
}

function regValue(key, valueName) {
  const result = spawnSync('reg.exe', ['query', key, '/v', valueName], { encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) return '';
  const pattern = new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_\\w+\\s+(.+)$`, 'mi');
  const match = result.stdout.match(pattern);
  return match ? match[1].trim() : '';
}

function desktopShortcutPath() {
  return path.join(os.homedir(), 'Desktop', 'Ollama Agent Harness.lnk');
}

function startMenuDirPath() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ollama Agent Harness');
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanupInstallDir(installDir) {
  try {
    fs.rmSync(installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.warn(`Installer smoke cleanup skipped: ${error.message || error}`);
  }
}

function cleanupRuntimeState(installDir) {
  try {
    fs.rmSync(path.join(installDir, '.harness'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.warn(`Installer smoke runtime cleanup skipped: ${error.message || error}`);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url, child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) throw new Error(`Installed server exited early with code ${child.exitCode}: ${getOutput()}`);
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && body.includes('Ollama Agent Harness')) return;
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for installed server: ${getOutput()}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(500);
  }
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});