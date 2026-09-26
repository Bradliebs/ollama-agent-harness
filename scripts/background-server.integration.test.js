const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { start, stop, status } = require('./background-server');

for (const shutdownMode of ['stop', 'supervisor-exit']) {
test(`built web server preserves an occupied port and stops active chat on ${shutdownMode}`, { timeout: 30000 }, async () => {
  // Long-form path: fs.watch on a Windows 8.3 short path (e.g. the runner's
  // C:\Users\RUNNER~1 temp dir) trips a libuv assertion in fs-event.c.
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "harness lifecycle ' "));
  const sentinel = http.createServer((_request, response) => response.end('unrelated listener'));
  await new Promise(resolve => sentinel.listen(0, '127.0.0.1', resolve));
  const preferred = sentinel.address().port;
  const readyFile = path.join(root, 'ready.json');
  const exitFile = path.join(root, 'exited.json');
  let watcher;
  let timer;
  let childPid;
  let supervisor;
  let supervisorExit;
  const ready = new Promise((resolve, reject) => {
    watcher = fs.watch(root, () => {
      if (!fs.existsSync(readyFile)) return;
      try { resolve(JSON.parse(fs.readFileSync(readyFile, 'utf8'))); }
      catch (error) { reject(error); }
    });
    timer = setTimeout(() => {
      const log = path.join(root, '.harness', 'background.log');
      reject(new Error('Built server did not report readiness.\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'No startup log.')));
    }, 20000);
  });
  ready.catch(() => {});
  try {
    fs.mkdirSync(path.join(root, 'dist', 'web'), { recursive: true });
    const target = path.resolve(__dirname, '..', 'dist', 'web', 'server.js');
    fs.writeFileSync(path.join(root, 'dist', 'web', 'server.js'), `
      const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT']);
      for (const key of Object.keys(process.env)) if (!allowed.has(key.toUpperCase())) delete process.env[key];
      Object.assign(process.env, ${JSON.stringify({ PORT: String(preferred), HOST: '127.0.0.1', NO_OPEN: '1', HARNESS_PROJECT_DIR: root, HARNESS_DISABLE_STARTUP_CONNECTORS: '1' })});
      const runtime = require(${JSON.stringify(target)});
      process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(exitFile)}, 'exited'));
      runtime.setWebRuntimeOverrides({
        createClient: () => ({}),
        getModelContextWindow: async () => 8192,
        getTools: () => [],
        assembleSystemContext: async () => 'Synthetic lifecycle fixture.',
        getEvolvedPrompt: async prompt => prompt,
        onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
        rebuildSemanticMemory: async () => [],
        runQueryLoop: async function* (config) {
          yield { type: 'text', content: 'Lifecycle fixture waiting.' };
          await new Promise(resolve => {
            if (config.abortSignal.aborted) resolve();
            else config.abortSignal.addEventListener('abort', resolve, { once: true });
          });
          console.log('Lifecycle fixture observed cancellation.');
          yield { type: 'done', reason: 'aborted' };
        },
      });
      runtime.startServer().then(server => {
        runtime.registerShutdownHandlers(server);
        const reportReady = () => {
          const fs = require('node:fs');
          fs.writeFileSync(${JSON.stringify(readyFile + '.tmp')}, JSON.stringify({ port: server.address().port, pid: process.pid }));
          fs.renameSync(${JSON.stringify(readyFile + '.tmp')}, ${JSON.stringify(readyFile)});
        };
        if (server.listening) reportReady();
        else server.once('listening', reportReady);
      }).catch(error => { console.error(error); process.exit(1); });
    `);
    if (shutdownMode === 'supervisor-exit') {
      const preload = path.join(root, 'supervisor-fixture.cjs');
      fs.writeFileSync(preload, "process.on('message', message => { if (message?.type === 'fixture:exit') process.exit(1); });");
      supervisor = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'background-server.js'), 'supervise', root], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      supervisorExit = new Promise(resolve => supervisor.once('close', resolve));
    } else assert.match(await start(root), /launched/);
    const address = await ready;
    childPid = address.pid;
    clearTimeout(timer);
    watcher.close();
    assert.notEqual(address.port, preferred);
    const response = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Ollama Agent Harness/);
    assert.deepEqual(await status(root), { state: 'running', port: address.port });
    assert.match(await start(root), /already owns/);
    const chat = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', message: 'Discuss the lifecycle fixture.' }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(chat.status, 200);
    const reader = chat.body.getReader();
    let events = '';
    while (!events.includes('Lifecycle fixture waiting.')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, events);
      events += new TextDecoder().decode(chunk.value);
    }
    if (shutdownMode === 'stop') assert.equal(await stop(root), 'Server stopped.');
    else {
      const marker = path.join(root, '.harness', 'background-owner.json');
      let exitWatcher;
      let exitTimer;
      try {
        const exited = process.platform === 'win32' ? null : new Promise((resolve, reject) => {
          exitWatcher = fs.watch(root, () => { if (fs.existsSync(exitFile)) resolve(); });
          exitTimer = setTimeout(() => reject(new Error('Owned server did not record disconnect cleanup')), 10000);
        });
        supervisor.send({ type: 'fixture:exit' });
        await supervisorExit;
        if (process.platform === 'win32') {
          await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$owned = Get-Process -Id ${childPid} -ErrorAction SilentlyContinue; if ($owned) { $owned | Wait-Process -Timeout 5 -ErrorAction Stop }; exit 0`], { timeout: 8000, windowsHide: true });
          assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
          assert.equal(fs.existsSync(exitFile), false, 'Windows job termination cannot promise JavaScript cleanup');
        } else await exited;
        assert.ok(fs.existsSync(marker), 'Crash must retain ownership evidence for reconciliation');
        assert.deepEqual(await status(root), { state: 'unmanaged', port: null });
      } finally {
        clearTimeout(exitTimer);
        exitWatcher?.close();
      }
    }
    // A Windows supervisor exit kills the server abruptly, so the open chat
    // stream can already be terminated; that is the expected outcome there.
    await reader.cancel().catch((error) => {
      if (!(shutdownMode === 'supervisor-exit' && process.platform === 'win32')) throw error;
    });
    if (shutdownMode === 'stop' || process.platform !== 'win32') {
      assert.match(fs.readFileSync(path.join(root, '.harness', 'background.log'), 'utf8'), /Graceful shutdown requested/);
      assert.match(fs.readFileSync(path.join(root, '.harness', 'background.log'), 'utf8'), /Lifecycle fixture observed cancellation/);
    }
    await assert.rejects(fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(3000) }));
    const preserved = await fetch(`http://127.0.0.1:${preferred}/`, { signal: AbortSignal.timeout(3000) });
    assert.equal(await preserved.text(), 'unrelated listener');
  } finally {
    clearTimeout(timer);
    watcher.close();
    await stop(root);
    if (supervisor) { supervisor.kill(); await supervisorExit; }
    if (shutdownMode === 'supervisor-exit' && childPid && !fs.existsSync(exitFile)) {
      try { process.kill(childPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    sentinel.closeAllConnections();
    await new Promise(resolve => sentinel.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
}