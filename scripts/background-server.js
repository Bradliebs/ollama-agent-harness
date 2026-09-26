const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function endpoint(root) {
  const canonical = fs.realpathSync(root);
  const identity = crypto.createHash('sha256').update((process.platform === 'win32' ? canonical.toLowerCase() : canonical) + os.homedir()).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? '\\\\.\\pipe\\harness-' + identity : path.join(os.tmpdir(), 'harness-' + identity + '.sock');
}

function start(root) {
  if (fs.existsSync(path.join(root, '.harness', 'maintenance.json'))) return Promise.reject(new Error('Installation maintenance is active or unfinished. Complete or reconcile maintenance before launching.'));
  if (fs.existsSync(path.join(root, '.harness', 'server.pid'))) {
    return Promise.reject(new Error('Legacy server.pid cannot prove process ownership. Stop the old server manually and remove that file before using background mode.'));
  }
  if (!fs.existsSync(path.join(root, 'dist', 'web', 'server.js'))) return Promise.reject(new Error('Missing prebuilt server. Build or reinstall first.'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, 'supervise', root], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Background supervisor startup timed out.')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Background supervisor exited before startup: ' + code)); });
    child.once('message', message => {
      clearTimeout(timer);
      child.disconnect();
      child.unref();
      if (message.error) reject(new Error(message.error));
      else resolve(message.status);
    });
  });
}

function request(root, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint(root));
    let response = '';
    socket.setTimeout(command === 'stop' ? 10000 : 2000, () => socket.destroy(new Error('Background request timed out; inspect background.log.')));
    socket.once('connect', () => socket.write(command + '\n'));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.once('end', () => {
      if (command === 'status') {
        try { resolve(JSON.parse(response)); } catch { reject(new Error('Invalid supervisor status.')); }
      } else if (response === 'stopped\n') resolve('Server stopped.');
      else if (response === 'forced\n') resolve('Server stopped after forced termination; active work may not be saved.');
      else reject(new Error('Invalid supervisor response; no PID-based stop attempted.'));
    });
    socket.once('error', error => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(command === 'status' ? { state: 'unmanaged', port: null } : 'No managed server found. No processes were stopped. Legacy PID files are not trusted.');
      else reject(error);
    });
  });
}

function stop(root) { return request(root, 'stop'); }
function status(root) { return request(root, 'status'); }

async function prepareMaintenance(root) {
  if (!fs.existsSync(root)) return 'No existing installation.';
  if (fs.existsSync(path.join(root, '.harness', 'server.pid'))) throw new Error('Stop the legacy server manually and reconcile server.pid before maintenance.');
  await stop(root);
  if (fs.existsSync(path.join(root, '.harness', 'background-owner.json'))) throw new Error('Unreconciled background ownership blocks maintenance. Confirm the old server has stopped before removing its marker.');
  return 'Managed server stopped; maintenance may proceed. Foreground servers must be stopped manually.';
}

async function beginMaintenance(root, token) {
  if (!token) throw new Error('Maintenance ownership token is required.');
  fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
  const marker = path.join(root, '.harness', 'maintenance.json');
  try {
    fs.writeFileSync(marker, JSON.stringify({ token, startedAt: new Date().toISOString() }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Installation maintenance is active or unfinished. Reconcile .harness/maintenance.json before retrying.');
    throw error;
  }
  await prepareMaintenance(root);
  return 'Maintenance ownership acquired. Background launches remain blocked until completion.';
}

function endMaintenance(root, token) {
  const marker = path.join(root, '.harness', 'maintenance.json');
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (!token || owner.token !== token) throw new Error('Maintenance ownership does not match; marker was not removed.');
  fs.unlinkSync(marker);
  return 'Maintenance completed; background launches are enabled.';
}

function supervise(root) {
  let child;
  let port = null;
  let stopping = false;
  let forced = false;
  let stopTimer;
  let ownsMarker = false;
  const marker = path.join(root, '.harness', 'background-owner.json');
  const waiters = new Set();
  const server = net.createServer(socket => {
    socket.setTimeout(1000, () => socket.destroy());
    socket.once('error', () => waiters.delete(socket));
    let request = '';
    socket.on('data', chunk => {
      request += chunk.toString();
      if (request.length > 16) { socket.destroy(); return; }
      if (!request.includes('\n')) return;
      if (request === 'status\n') {
        socket.end(JSON.stringify({ state: stopping ? 'stopping' : port === null ? 'starting' : 'running', port }));
        return;
      }
      if (request !== 'stop\n') { socket.destroy(); return; }
      socket.setTimeout(0);
      waiters.add(socket);
      if (!stopping && child) {
        stopping = true;
        stopTimer = setTimeout(() => {
          forced = true;
          const message = 'Graceful shutdown timed out; terminating the owned server. Active work may not be saved.\n';
          try { fs.appendFileSync(path.join(root, '.harness', 'background.log'), message); }
          catch (error) { console.error('Cannot record forced shutdown: ' + error.message); }
          child.kill('SIGKILL');
        }, 7000);
        if (child.connected) {
          child.send({ type: 'harness:shutdown' }, error => {
            if (error) console.error('Shutdown request failed: ' + error.message);
          });
        } else { forced = true; child.kill(); }
      }
    });
  });
  function finish() {
    clearTimeout(stopTimer);
    if (ownsMarker) {
      ownsMarker = false;
      try { fs.unlinkSync(marker); }
      catch (error) { console.error('Ownership marker cleanup failed: ' + error.message); }
    }
    for (const socket of waiters) socket.end(forced ? 'forced\n' : 'stopped\n');
    server.close();
  }
  server.once('error', error => {
    if (process.connected) process.send(error.code === 'EADDRINUSE' ? { status: 'A background supervisor already owns this installation; no second server started.' } : { error: error.message });
  });
  server.listen(endpoint(root), () => {
    let log;
    try {
      fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
      try {
        fs.writeFileSync(marker, JSON.stringify({ supervisorPid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
        ownsMarker = true;
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Unreconciled background ownership marker. Confirm the previous server has stopped, then remove .harness/background-owner.json before relaunching.');
        throw error;
      }
      if (fs.existsSync(path.join(root, '.harness', 'maintenance.json'))) throw new Error('Installation maintenance blocks background launch.');
      log = fs.openSync(path.join(root, '.harness', 'background.log'), 'a');
      child = spawn(process.execPath, [path.join(root, 'dist', 'web', 'server.js')], { cwd: root, windowsHide: true, stdio: ['ignore', log, log, 'ipc'] });
      child.on('message', message => {
        if (message?.type === 'harness:ready' && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) port = message.port;
      });
      child.once('spawn', () => {
        if (process.connected) process.send({ status: 'Background process launched. Readiness and the chosen URL are recorded in .harness/background.log.' });
      });
      child.once('error', error => {
        if (process.connected) process.send({ error: error.message });
        finish();
      });
      child.once('exit', finish);
    } catch (error) {
      if (process.connected) process.send({ error: error.message });
      finish();
    } finally {
      if (log !== undefined) fs.closeSync(log);
    }
  });
}

if (require.main === module) {
  const root = ['supervise', 'prepare-maintenance', 'begin-maintenance', 'end-maintenance'].includes(process.argv[2]) ? process.argv[3] : path.resolve(__dirname, '..');
  if (process.argv[2] === 'supervise') supervise(root);
  else if (['begin-maintenance', 'end-maintenance'].includes(process.argv[2]) && root) {
    const action = process.argv[2] === 'begin-maintenance' ? beginMaintenance : endMaintenance;
    Promise.resolve().then(() => action(path.resolve(root), process.argv[4])).then(result => console.log(result)).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
  else if (process.argv[2] === 'prepare-maintenance' && root) {
    prepareMaintenance(path.resolve(root)).then(result => console.log(result)).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
  else if (['start', 'stop', 'status'].includes(process.argv[2])) {
    const action = { start, stop, status }[process.argv[2]];
    action(root).then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
  } else { console.error('Usage: node scripts/background-server.js start|stop|status|prepare-maintenance <installation>|begin-maintenance|end-maintenance <installation> <token>'); process.exitCode = 1; }
}

module.exports = { start, stop, status, prepareMaintenance, beginMaintenance, endMaintenance };