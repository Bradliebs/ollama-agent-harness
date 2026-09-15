#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { stop, status } = require('./background-server');

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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-workspace-'));
  const markerPath = path.join(workspace, 'preserve.txt');
  fs.writeFileSync(markerPath, 'Installer must preserve workspace data.');

  let keepInstall = options.keep;
  try {
    run(installerPath, ['/S', `/D=${installDir}`], process.cwd(), 20 * 60 * 1000);
    await waitFor(() => fs.existsSync(path.join(installDir, 'uninstall.exe')), 30_000, 'Timed out waiting for installer output.');

    const installed = verifyInstall(installDir);
    await verifyServerStarts(installDir, workspace);
    const stateMarker = path.join(installDir, '.harness', 'preserve.txt');
    fs.mkdirSync(path.dirname(stateMarker), { recursive: true });
    fs.writeFileSync(stateMarker, 'Installer must preserve local state.');
    await verifyServerStarts(installDir, workspace, () => run(installerPath, ['/S', `/D=${installDir}`], process.cwd(), 20 * 60 * 1000));
    verifyInstall(installDir);

    if (!keepInstall) await verifyServerStarts(installDir, workspace, () => uninstallAndVerify(installDir));
    if (fs.readFileSync(stateMarker, 'utf8') !== 'Installer must preserve local state.') throw new Error('Installation-local state changed during maintenance.');
    if (fs.readFileSync(markerPath, 'utf8') !== 'Installer must preserve workspace data.') throw new Error('Workspace data changed across reinstall or uninstall.');

    console.log(JSON.stringify({ ok: true, installer: installerPath, installDir, installed, kept: keepInstall, activeReinstall: true, activeUninstall: !keepInstall, workspacePreserved: true, localStatePreserved: true }, null, 2));
  } catch (error) {
    keepInstall = true;
    throw error;
  } finally {
    if (!keepInstall) {
      cleanupInstallDir(installDir);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
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
reinstalls and uninstalls while the managed server is running, then verifies
application cleanup and preservation of local state and the external workspace.

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
  assertFile(installDir, 'release-provenance.json');
  assertFile(installDir, 'scripts/check-runtime.js');
  assertFile(installDir, 'scripts/background-server.js');
  const launchMode = run(process.execPath, ['scripts/check-runtime.js', '--launch-mode'], installDir, 60_000, true);
  if (launchMode.stdout.trim() !== 'prebuilt') throw new Error('Installed launcher did not recognize a complete prebuilt release.');

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

async function verifyServerStarts(installDir, workspace, maintenance) {
  const port = await getFreePort();
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', NO_OPEN: '1', HARNESS_PROJECT_DIR: workspace, HARNESS_DISABLE_STARTUP_CONNECTORS: '1' });
  const helper = path.join(installDir, 'scripts/background-server.js');
  const output = () => {
    const log = path.join(installDir, '.harness/background.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'No background log.';
  };
  try {
    run(process.execPath, [helper, 'start'], installDir, 15000, true, env);
    await waitForServer(`http://127.0.0.1:${port}/`, output);
    const repeated = run(process.execPath, [helper, 'start'], installDir, 15000, true, env);
    if (!repeated.stdout.includes('already owns')) throw new Error('Repeated installed launch did not detect its supervisor.');
    if (maintenance) {
      await maintenance();
      if ((await status(installDir)).state !== 'unmanaged') throw new Error('Maintenance left the managed server running.');
      if (fs.existsSync(path.join(installDir, '.harness/background-owner.json'))) throw new Error('Maintenance left unresolved server ownership.');
      if (fs.existsSync(path.join(installDir, '.harness/maintenance.json'))) throw new Error('Successful maintenance left its launch-blocking lease behind.');
    }
  } finally {
    await stop(installDir);
  }
}

async function uninstallAndVerify(installDir) {
  const uninstaller = path.join(installDir, 'uninstall.exe');
  if (!fs.existsSync(uninstaller)) throw new Error('Missing uninstaller after smoke install.');
  run(uninstaller, ['/S'], os.tmpdir(), 5 * 60 * 1000, true);
  await waitFor(() => !hasInstallFootprint(installDir), 90_000, 'Timed out waiting for installer smoke cleanup.');
}

function hasInstallFootprint(installDir) {
  return ['dist', 'ui', 'node_modules', 'package.json', 'uninstall.exe', 'scripts/background-server.js'].some(name => fs.existsSync(path.join(installDir, name)))
    || Boolean(regValue(registryInstallKey, 'InstallDir'))
    || Boolean(regValue(registryUninstallKey, 'DisplayVersion'))
    || fs.existsSync(desktopShortcutPath())
    || fs.existsSync(startMenuDirPath());
}

function assertFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`Missing installed file: ${relativePath}`);
}

function run(command, args, cwd, timeout, capture = false, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
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

async function waitForServer(url, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await response.text();
      if (response.ok && body.includes('Ollama Agent Harness')) return;
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for installed server: ${getOutput()}`);
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