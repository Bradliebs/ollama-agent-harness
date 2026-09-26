const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function worker(workspace, mode, boundary) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { PROJECT_DIR: workspace, HARNESS_ROOT: path.resolve(__dirname, '..') });
  const child = fork(path.join(__dirname, 'fixtures/resume-worker.cjs'), [mode, boundary], {
    cwd: workspace, env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, closed };
}

for (const boundary of ['before-result', 'after-result']) {
  test(`fresh worker resumes after interruption ${boundary} without replaying the ledger write`, { timeout: 30000 }, async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness resume 'fixture-"));
    const workers = [];
    const timeout = setTimeout(() => {
      for (const running of workers) running.child.kill();
    }, 25000);
    try {
      const original = worker(workspace, 'start', boundary);
      workers.push(original);
      await Promise.race([
        new Promise(resolve => original.child.once('message', resolve))
          .then(message => assert.deepEqual(message, { type: 'interruptible', boundary })),
        original.closed.then(result => { throw new Error(`Worker exited before interruption: ${JSON.stringify(result)}`); }),
      ]);
      assert.equal(await fs.readFile(path.join(workspace, 'ledger.txt'), 'utf8'), 'entry\n');
      original.child.kill();
      await original.closed;
      const transcriptPath = path.join(workspace, '.harness/sessions/interrupted.jsonl');
      const before = await fs.readFile(transcriptPath, 'utf8');
      const persisted = before.trim().split('\n').map(line => JSON.parse(line));
      assert.ok(persisted.some(event => event.data.kind === 'message' && event.data.message.tool_calls?.[0]?.id === 'append-original'));
      const savedResult = persisted.find(event => event.data.kind === 'tool_result');
      assert.equal(Boolean(savedResult), boundary === 'after-result');

      const resumed = worker(workspace, 'resume', boundary);
      workers.push(resumed);
      const exit = await resumed.closed;
      assert.equal(exit.code, 0, JSON.stringify(exit));
      const messages = JSON.parse(await fs.readFile(path.join(workspace, 'resumed-messages.json'), 'utf8'));
      if (savedResult) assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'append-original'));
      const report = JSON.parse(await fs.readFile(path.join(workspace, 'resume-result.json'), 'utf8'));
      assert.deepEqual(report.permissionChecks, [{ name: 'append_entry', allowed: false }, { name: 'read_ledger', allowed: true }]);
      assert.ok(report.events.some(event => event.type === 'tool_result' && event.call.name === 'append_entry' && !event.result.success));
      assert.ok(report.events.some(event => event.type === 'tool_result' && event.call.name === 'read_ledger' && event.result.success && event.result.output === 'entry\n'));
      assert.ok(report.events.some(event => event.type === 'done' && event.reason === 'completed'));
      assert.equal(report.meta.status, 'completed');
      assert.equal(await fs.readFile(path.join(workspace, 'ledger.txt'), 'utf8'), 'entry\n');
      assert.ok((await fs.readFile(transcriptPath, 'utf8')).startsWith(before));
    } finally {
      clearTimeout(timeout);
      for (const running of workers) {
        if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill();
        await running.closed;
      }
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}