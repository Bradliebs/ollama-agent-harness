const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { start, stop, status, prepareMaintenance, beginMaintenance, endMaintenance } = require('./background-server');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness background ' "));
  fs.mkdirSync(path.join(root, 'dist', 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'web', 'server.js'), "process.on('message', message => { if (message?.type === 'harness:shutdown') process.exit(0); }); setInterval(() => {}, 1000);");
  return root;
}

test('concurrent starts own one supervisor; stop and restart use no PID file', { timeout: 20000 }, async () => {
  const root = fixture();
  try {
    const results = await Promise.all([start(root), start(root)]);
    assert.equal(results.filter(result => result.includes('launched')).length, 1);
    assert.equal(results.filter(result => result.includes('already owns')).length, 1);
    assert.equal(fs.existsSync(path.join(root, '.harness', 'server.pid')), false);
    assert.deepEqual(await status(root), { state: 'starting', port: null });
    assert.equal(await stop(root), 'Server stopped.');
    assert.deepEqual(await status(root), { state: 'unmanaged', port: null });
    assert.equal(fs.existsSync(path.join(root, '.harness', 'background-owner.json')), false);
    assert.match(await start(root), /launched/);
    assert.equal(await stop(root), 'Server stopped.');
    assert.match(await stop(root), /No processes were stopped/);
  } finally {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('legacy PID pointing at an unrelated live process never authorizes a kill', { timeout: 10000 }, async () => {
  const root = fixture();
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => unrelated.once('exit', resolve));
  try {
    fs.mkdirSync(path.join(root, '.harness'));
    fs.writeFileSync(path.join(root, '.harness', 'server.pid'), String(unrelated.pid));
    assert.match(await stop(root), /No processes were stopped/);
    await assert.rejects(start(root), /cannot prove process ownership/);
    assert.equal(unrelated.exitCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.equal(fs.readFileSync(path.join(root, '.harness', 'server.pid'), 'utf8'), String(unrelated.pid));
  } finally {
    unrelated.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stopping a different installation leaves the running supervisor owned', { timeout: 10000 }, async () => {
  const root = fixture();
  const other = fixture();
  try {
    await start(root);
    assert.match(await stop(other), /No processes were stopped/);
    assert.match(await start(root), /already owns/);
    assert.equal(await stop(root), 'Server stopped.');
  } finally {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('release packaging carries both shortcuts and the installer carries the supervisor', () => {
  const { releaseArchiveEntries } = require('./release-package');
  for (const entry of ['scripts', 'start-background.bat', 'stop-server.bat']) assert.ok(releaseArchiveEntries().includes(entry));
  const installer = fs.readFileSync(path.join(__dirname, '..', 'installer', 'harness-installer.nsi'), 'utf8');
  assert.match(installer, /File "\.\.\\scripts\\background-server\.js"/);
  assert.match(installer, /Delete "\$INSTDIR\\scripts\\background-server\.js"/);
  assert.match(installer, /Section "Install"\s+!insertmacro PrepareMaintenance Install\s+SetOutPath/);
  assert.match(installer, /Section "Uninstall"\s+!insertmacro PrepareMaintenance Uninstall/);
  assert.match(installer, /begin-maintenance "\$INSTDIR" "\$PLUGINSDIR"/);
  assert.match(installer, /end-maintenance "\$INSTDIR" "\$PLUGINSDIR"/);
  assert.match(installer, /!insertmacro CompleteMaintenance Install\s+SectionEnd/);
  assert.match(installer, /!insertmacro CompleteMaintenance Uninstall\s+SectionEnd/);
});

test('maintenance stops only its owned server and refuses unresolved ownership', { timeout: 15000 }, async () => {
  const root = fixture();
  const other = fixture();
  try {
    await start(root);
    await start(other);
    assert.match(await prepareMaintenance(root), /maintenance may proceed/);
    assert.deepEqual(await status(root), { state: 'unmanaged', port: null });
    assert.equal((await status(other)).state, 'starting');
    const marker = path.join(root, '.harness', 'background-owner.json');
    fs.writeFileSync(marker, JSON.stringify({ supervisorPid: process.pid }));
    await assert.rejects(prepareMaintenance(root), /ownership blocks maintenance/);
    assert.ok(fs.existsSync(marker));
    fs.unlinkSync(marker);
    fs.writeFileSync(path.join(root, '.harness', 'server.pid'), String(process.pid));
    await assert.rejects(prepareMaintenance(root), /legacy server manually/);
    assert.match(await prepareMaintenance(path.join(root, 'not-installed')), /No existing installation/);
  } finally {
    await stop(root);
    await stop(other);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('maintenance ownership blocks launches and competing maintenance until its owner completes', { timeout: 15000 }, async () => {
  const root = fixture();
  try {
    await start(root);
    await beginMaintenance(root, 'first-installer');
    assert.deepEqual(await status(root), { state: 'unmanaged', port: null });
    await assert.rejects(start(root), /maintenance is active or unfinished/);
    await assert.rejects(beginMaintenance(root, 'second-installer'), /maintenance is active or unfinished/);
    assert.throws(() => endMaintenance(root, 'second-installer'), /ownership does not match/);
    assert.ok(fs.existsSync(path.join(root, '.harness', 'maintenance.json')));
    endMaintenance(root, 'first-installer');
    assert.match(await start(root), /launched/);
  } finally {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('supervisor rechecks maintenance even when the launcher check was bypassed', { timeout: 10000 }, async () => {
  const root = fixture();
  let supervisor;
  let exited;
  try {
    await beginMaintenance(root, 'pending-launch');
    supervisor = spawn(process.execPath, [path.join(__dirname, 'background-server.js'), 'supervise', root], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    exited = new Promise((resolve, reject) => { supervisor.once('exit', resolve); supervisor.once('error', reject); });
    const message = await new Promise((resolve, reject) => {
      supervisor.once('message', resolve);
      supervisor.once('error', reject);
      supervisor.once('exit', () => reject(new Error('Supervisor exited without a maintenance verdict.')));
    });
    assert.match(message.error, /maintenance blocks background launch/);
    if (supervisor.connected) supervisor.disconnect();
    await exited;
    assert.deepEqual(await status(root), { state: 'unmanaged', port: null });
    assert.equal(fs.existsSync(path.join(root, '.harness', 'background-owner.json')), false);
    assert.ok(fs.existsSync(path.join(root, '.harness', 'maintenance.json')));
    endMaintenance(root, 'pending-launch');
  } finally {
    if (supervisor && supervisor.exitCode === null) supervisor.kill();
    if (exited) await exited;
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('maintenance CLI holds a fresh installation lease across separate processes', () => {
  const parent = fixture();
  const root = path.join(parent, "new installation ' path");
  const helper = path.join(__dirname, 'background-server.js');
  const token = "installer temp ' ownership";
  const invoke = (command, owner) => spawnSync(process.execPath, [helper, command, root, owner], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  try {
    const acquired = invoke('begin-maintenance', token);
    assert.equal(acquired.status, 0, acquired.stderr);
    assert.match(acquired.stdout, /ownership acquired/);
    const other = invoke('end-maintenance', 'different installer');
    assert.equal(other.status, 1, other.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.harness', 'maintenance.json'), 'utf8')).token, token);
    const released = invoke('end-maintenance', token);
    assert.equal(released.status, 0, released.stderr);
    assert.equal(fs.existsSync(path.join(root, '.harness', 'maintenance.json')), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('failed maintenance retains its marker and prevents unsafe relaunch', async () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, '.harness'));
    fs.writeFileSync(path.join(root, '.harness', 'server.pid'), String(process.pid));
    await assert.rejects(beginMaintenance(root, 'interrupted-installer'), /legacy server manually/);
    assert.ok(fs.existsSync(path.join(root, '.harness', 'maintenance.json')));
    await assert.rejects(start(root), /maintenance is active or unfinished/);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tray stop shortcut exits without a hidden keyboard prompt', { skip: process.platform !== 'win32', timeout: 10000 }, () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(__dirname, 'background-server.js'), path.join(root, 'scripts', 'background-server.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'stop-server.bat'), path.join(root, 'stop-server.bat'));
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', 'stop-server.bat --no-pause'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No processes were stopped/);
    const tray = fs.readFileSync(path.join(__dirname, 'tray.ps1'), 'utf8');
    assert.match(tray, /-ArgumentList '--no-pause'.*-WindowStyle Hidden -Wait/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale supervisor marker blocks relaunch without trusting its PID', { timeout: 10000 }, async () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, '.harness'));
    const marker = path.join(root, '.harness', 'background-owner.json');
    const record = JSON.stringify({ supervisorPid: process.pid });
    fs.writeFileSync(marker, record);
    await assert.rejects(start(root), /Unreconciled background ownership/);
    assert.equal(fs.readFileSync(marker, 'utf8'), record);
    assert.match(await stop(root), /No processes were stopped/);
    fs.unlinkSync(marker);
    assert.match(await start(root), /launched/);
  } finally {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('stop requests cooperative cleanup before reporting the child stopped', { timeout: 15000 }, async () => {
  const root = fixture();
  const cleaned = path.join(root, 'cleaned.txt');
  fs.writeFileSync(path.join(root, 'dist', 'web', 'server.js'), `
    process.on('message', message => {
      if (message?.type !== 'harness:shutdown') return;
      require('node:fs').writeFileSync(${JSON.stringify(cleaned)}, 'cleaned');
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `);
  try {
    await start(root);
    assert.equal(await stop(root), 'Server stopped.');
    assert.equal(fs.readFileSync(cleaned, 'utf8'), 'cleaned');
  } finally {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('stop bounds an unresponsive owned child without removing ownership early', { timeout: 15000 }, async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'dist', 'web', 'server.js'), 'setInterval(() => {}, 1000);');
  try {
    await start(root);
    const stopped = stop(root);
    assert.equal(fs.existsSync(path.join(root, '.harness', 'background-owner.json')), true);
    assert.match(await stopped, /forced termination; active work may not be saved/);
    assert.match(fs.readFileSync(path.join(root, '.harness', 'background.log'), 'utf8'), /Graceful shutdown timed out/);
    assert.equal(fs.existsSync(path.join(root, '.harness', 'background-owner.json')), false);
    assert.deepEqual(await status(root), { state: 'unmanaged', port: null });
  } finally {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const action of ['stop', 'supervisor-loss']) {
  test(`Windows ${action} closes ordinary nested descendants without stopping an unrelated process`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const root = fixture();
    const sockets = new Set();
    const descendants = new Set();
    const closed = [];
    let ready;
    const allReady = new Promise(resolve => { ready = resolve; });
    const listener = net.createServer(socket => {
      sockets.add(socket);
      closed.push(new Promise(resolve => socket.once('close', resolve)));
      socket.once('error', () => {});
      let label = '';
      socket.on('data', chunk => {
        label += chunk;
        if (!label.includes('\n')) return;
        descendants.add(label.trim());
        if (descendants.has('1') && descendants.has('2')) ready();
      });
    });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const unrelatedExit = new Promise(resolve => unrelated.once('exit', resolve));
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Nested descendant lifecycle timed out')), 15000); });
    try {
      await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
      fs.writeFileSync(path.join(root, 'dist', 'web', 'server.js'), `
        require('node:child_process').spawn(process.execPath, [${JSON.stringify(path.join(__dirname, 'fixtures', 'lifecycle-descendant.cjs'))}, ${JSON.stringify(String(listener.address().port))}, '1'], { detached: false, windowsHide: true, stdio: 'ignore' });
        process.on('message', message => { if (message?.type === 'harness:shutdown') process.exit(0); });
        setInterval(() => {}, 1000);
      `);
      await start(root);
      await Promise.race([allReady, deadline]);
      if (action === 'stop') assert.equal(await stop(root), 'Server stopped.');
      else {
        const marker = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'background-owner.json'), 'utf8'));
        process.kill(marker.supervisorPid);
      }
      await Promise.race([Promise.all(closed), deadline]);
      assert.equal(unrelated.exitCode, null);
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
      assert.equal(fs.existsSync(path.join(root, '.harness', 'background-owner.json')), action === 'supervisor-loss');
    } finally {
      clearTimeout(timer);
      await stop(root);
      for (const socket of sockets) { if (!socket.destroyed) socket.end('stop'); }
      await Promise.all(closed);
      await new Promise(resolve => listener.close(resolve));
      unrelated.kill();
      await unrelatedExit;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

test('tray discovers the owned port and clears its URL after stop', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, 'background-server.js'), path.join(root, 'scripts', 'background-server.js'));
  fs.writeFileSync(path.join(root, 'dist', 'web', 'server.js'), `
    process.on('message', message => {
      if (message?.type === 'harness:shutdown') process.exit(0);
    });
    process.send({ type: 'harness:ready', port: 54321 });
    setInterval(() => {}, 1000);
  `);
  const tray = path.join(__dirname, 'tray.ps1');
  const invoke = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:HARNESS_TEST_TRAY, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw $parseErrors[0] }
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-HarnessStatus' }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
    $Script:HarnessRoot = $env:HARNESS_TEST_ROOT
    $Script:HarnessBase = 'http://127.0.0.1:4300'
    Get-HarnessStatus
    @{ state = $Script:ManagedState; url = $Script:HarnessBase } | ConvertTo-Json -Compress
  // Windows PowerShell cold starts on hosted runners can exceed 5s.
  `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, HARNESS_TEST_ROOT: root, HARNESS_TEST_TRAY: tray } });
  try {
    await start(root);
    const running = invoke();
    assert.equal(running.status, 0, running.stderr);
    assert.deepEqual(JSON.parse(running.stdout), { state: 'running', url: 'http://127.0.0.1:54321' });
    await stop(root);
    const stopped = invoke();
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), { state: 'unmanaged', url: null });
    assert.doesNotMatch(fs.readFileSync(tray, 'utf8'), /server\.pid|Get-Process -Id/);
  } finally {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});