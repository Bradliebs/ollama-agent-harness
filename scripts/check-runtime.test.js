const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { supportsRuntime, launchMode } = require('./check-runtime');

test('runtime floor matches package metadata and rejects unsupported versions', () => {
  assert.equal(require('../package.json').engines.node, '>=22.13.0');
  for (const version of ['18.20.0', '20.19.0', '22.12.0', 'invalid']) assert.equal(supportsRuntime(version), false);
  for (const version of ['22.13.0', '22.15.0', '24.0.0']) assert.equal(supportsRuntime(version), true);
});

test('only complete releases skip compilation; source always rebuilds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness launch '));
  try {
    assert.throws(() => launchMode(root), /provenance/);
    fs.writeFileSync(path.join(root, 'release-provenance.json'), '{}');
    assert.throws(() => launchMode(root), /prebuilt/);
    fs.mkdirSync(path.join(root, 'dist', 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'web', 'server.js'), '');
    assert.equal(launchMode(root), 'prebuilt');
    fs.mkdirSync(path.join(root, 'src', 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'web', 'server.ts'), '');
    assert.equal(launchMode(root), 'source');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows bootstrap preserves unrelated processes and uses runtime checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start.bat'), 'utf8');
  assert.doesNotMatch(source, /taskkill|Stop-Process/i);
  assert.match(source, /check-runtime\.js --launch-mode/);
  assert.match(source, /if not defined PORT set PORT=4300/);
});

test('portable bootstrap delegates browser readiness and validates prebuilt releases', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start.sh'), 'utf8');
  assert.match(source, /check-runtime\.js --launch-mode/);
  assert.match(source, /export PORT="\$\{PORT:-4300\}"/);
  assert.doesNotMatch(source, /sleep 2|xdg-open/);
});

test('stop shortcut does not kill an arbitrary listener when ownership is missing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'stop-server.bat'), 'utf8');
  assert.doesNotMatch(source, /netstat|taskkill|server\.pid/i);
  assert.match(source, /background-server\.js stop/);
});

test('background launch preserves occupied ports and supports prebuilt installs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start-background.bat'), 'utf8');
  assert.doesNotMatch(source, /netstat|taskkill \/PID %%p/i);
  assert.match(source, /check-runtime\.js --launch-mode/);
  assert.match(source, /if not exist src\\web\\server\.ts goto BUILD_OK/);
  assert.match(source, /if not defined PORT set PORT=4300/);
});

test('installer silent checks have defaults instead of blocking on message boxes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'installer', 'harness-installer.nsi'), 'utf8');
  assert.equal((source.match(/MessageBox/g) || []).length, (source.match(/\/SD IDOK/g) || []).length);
  assert.match(source, /npm ci --omit=dev/);
  assert.match(source, /StrCmp \$0 "0" DependenciesOK/);
});