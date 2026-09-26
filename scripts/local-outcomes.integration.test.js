const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, fork } = require('node:child_process');
const { createServer } = require('node:http');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeModelUsage, summarizeRequestUsage, describeContext } = require('./local-core-baseline');

test('context attribution accounts for exact JSON bytes by role without retaining content', () => {
  const messages = [
    { role: 'system', content: 'Context checkpoint' },
    { role: 'user', content: '\u00e9\n"quoted"', images: ['YWJj'] },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_read', arguments: { path: 'input.json' } } }] },
    { role: 'tool', content: '{"value":7}', tool_call_id: 'read-1' },
    { role: '__proto__', content: 'unknown role' },
  ];
  const tools = [{ type: 'function', function: { name: 'file_read', parameters: { type: 'object' } } }];
  const before = JSON.stringify({ messages, tools });
  const context = describeContext(messages, tools);
  assert.equal(context.messageCount, 5);
  assert.equal(context.messageBytes, Buffer.byteLength(JSON.stringify(messages)));
  assert.equal(context.schemaBytes, Buffer.byteLength(JSON.stringify(tools)));
  assert.equal(Object.values(context.byRole).reduce((sum, role) => sum + role.bytes, context.framingBytes), context.messageBytes);
  assert.equal(context.byRole.user.bytes, Buffer.byteLength(JSON.stringify(messages[1])));
  assert.equal(context.byRole.tool.messages, 1);
  assert.equal(context.byRole.other.messages, 1);
  assert.equal(JSON.stringify({ messages, tools }), before);
  assert.equal(JSON.stringify(context).includes('Context checkpoint'), false);
  const empty = describeContext([], undefined);
  assert.equal(empty.messageBytes, 2);
  assert.equal(empty.schemaBytes, 2);
  assert.equal(empty.framingBytes, 2);
  assert.equal(Object.values(empty.byRole).every(role => role.messages === 0 && role.bytes === 0), true);
});

test('actual benchmark worker emits raw SDK retry usage over IPC', { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-request-telemetry-'));
  const sockets = new Set();
  const events = [];
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    requests += 1;
    if (request.url !== '/api/chat') {
      response.writeHead(400).end();
    } else if (requests === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'fixture unavailable' }));
    } else {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end(JSON.stringify({ message: { role: 'assistant', content: '{"value":27}' }, done: true, prompt_eval_count: 12, eval_count: 6 }) + '\n');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let child;
  let closed;
  let timer;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.HARNESS_TRANSPORT_FIXTURE_PORT = String(server.address().port);
    child = fork(path.join(__dirname, 'local-core-baseline.js'), ['--worker', Buffer.from('Add 19 and 8.').toString('base64'), 'core', 'qwen3:1.7b'], {
      cwd: workspace, env, execArgv: ['--require', path.join(__dirname, 'fixtures/request-transport.cjs')],
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    let stdout = '';
    child.on('message', event => events.push(event));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16000); });
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    timer = setTimeout(() => child.kill(), 15000);
    assert.equal(await closed, 0, stderr);
    assert.equal(requests, 2, JSON.stringify({ stderr, stdout, events }));
    const attempts = events.filter(event => event.type === 'model-request');
    assert.deepEqual(attempts.map(event => [event.phase, event.requestId]), [['start', 1], ['error', 1], ['start', 2], ['complete', 2]]);
    const call = events.find(event => event.type === 'model-start');
    assert.ok(call.callId > 0);
    assert.equal(attempts.every(event => event.callId === call.callId), true);
    assert.equal(events.find(event => event.type === 'model-end').callId, call.callId);
    assert.equal(call.context.byRole.user.messages, 1);
    assert.ok(call.context.byRole.system.bytes > 0);
    assert.equal(call.context.messageBytes, call.messageBytes);
    assert.deepEqual(attempts[1].usage, { promptTokens: null, completionTokens: null });
    assert.deepEqual(attempts[3].usage, { promptTokens: 12, completionTokens: 6 });
    assert.ok(attempts[3].durationMs >= 0);
    const summary = summarizeRequestUsage([{ status: 'pass', metrics: { modelCalls: [call], modelRequests: attempts.filter(event => event.phase !== 'start') } }]);
    assert.equal(summary.allCallsLinked, true);
    assert.equal(summary.recordedCalls, 2);
    assert.equal(summary.knownReportedTokens, 18);
    assert.equal(summary.reportedTotalTokens, null);
    assert.equal(summary.reportedTokensPerPassedAttempt, null);
    assert.match(stdout, /"reason":"completed"/);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('request usage includes retries and never substitutes normalized client usage', () => {
  const complete = { callId: 1, durationMs: 1, usage: { promptTokens: 3, completionTokens: 2 } };
  const result = { status: 'pass', metrics: { modelCalls: [complete], modelRequests: [complete, complete] } };
  assert.equal(summarizeRequestUsage([result]).reportedTokensPerPassedAttempt, 10);
  result.metrics.modelRequests[0] = { callId: 1, durationMs: 1, usage: { promptTokens: null, completionTokens: null } };
  assert.equal(summarizeRequestUsage([result]).reportedTotalTokens, null);
  assert.equal(summarizeRequestUsage([result]).knownReportedTokens, 5);
  assert.equal(summarizeRequestUsage([{ status: 'pass', metrics: { modelCalls: [complete] } }]).reportedTotalTokens, null);
});

test('request totals stay unknown when any client call or raw request lacks matching lineage', () => {
  const complete = { callId: 1, durationMs: 1, usage: { promptTokens: 3, completionTokens: 2 } };
  for (const metrics of [
    { modelCalls: [complete, { ...complete, callId: 2 }], modelRequests: [complete] },
    { modelCalls: [complete], modelRequests: [complete, { ...complete, callId: 2 }] },
    { modelCalls: [{ ...complete, callId: undefined }], modelRequests: [{ ...complete, callId: undefined }] },
    { modelRequests: [complete] },
  ]) {
    const summary = summarizeRequestUsage([{ status: 'pass', metrics }]);
    assert.equal(summary.allCallsLinked, false);
    assert.equal(summary.allCallsReported, false);
    assert.ok(summary.knownReportedTokens > 0);
    assert.equal(summary.reportedTotalTokens, null);
    assert.equal(summary.reportedTokensPerPassedAttempt, null);
  }
});

test('usage summary includes failed attempts in reported tokens per pass', () => {
  const call = { durationMs: 1, usage: { promptTokens: 12, completionTokens: 6 } };
  const summary = summarizeModelUsage([
    { status: 'pass', metrics: { modelCalls: [call, call] } },
    { status: 'fail', metrics: { modelCalls: [call] } },
  ]);
  assert.equal(summary.recordedCalls, 3);
  assert.equal(summary.callsWithUsage, 3);
  assert.equal(summary.allCallsReported, true);
  assert.equal(summary.knownReportedTokens, 54);
  assert.equal(summary.reportedTotalTokens, 54);
  assert.equal(summary.reportedTokensPerPassedAttempt, 54);
});

test('usage summary keeps incomplete and invalid telemetry unknown', () => {
  const complete = { status: 'pass', metrics: { modelCalls: [{ durationMs: 1, usage: { promptTokens: 12, completionTokens: 6 } }] } };
  for (const call of [
    { durationMs: null, usage: null },
    { durationMs: 1, usage: null },
    { durationMs: null, usage: { promptTokens: 12, completionTokens: 6 } },
    { durationMs: 1, usage: { promptTokens: 12 } },
    { durationMs: 1, usage: { promptTokens: -1, completionTokens: 6 } },
    { durationMs: 1, usage: { promptTokens: '12', completionTokens: 6 } },
  ]) {
    const summary = summarizeModelUsage([complete, { status: 'error', metrics: { modelCalls: [call] } }]);
    assert.equal(summary.callsWithUsage, 1);
    assert.equal(summary.allCallsReported, false);
    assert.equal(summary.knownReportedTokens, 18);
    assert.equal(summary.reportedTotalTokens, null);
    assert.equal(summary.reportedTokensPerPassedAttempt, null);
  }
  for (const missing of [{ status: 'error' }, { status: 'error', metrics: { modelCalls: [] } }]) {
    assert.equal(summarizeModelUsage([complete, missing]).reportedTotalTokens, null);
  }
});

test('usage summary distinguishes reported zero from no observations and no passes', () => {
  const empty = summarizeModelUsage([]);
  assert.equal(empty.allCallsReported, false);
  assert.equal(empty.knownReportedTokens, null);
  assert.equal(empty.reportedTotalTokens, null);
  assert.equal(empty.reportedTokensPerPassedAttempt, null);
  const metrics = { modelCalls: [{ durationMs: 0, usage: { promptTokens: 0, completionTokens: 0 } }] };
  assert.equal(summarizeModelUsage([{ status: 'pass', metrics }]).reportedTokensPerPassedAttempt, 0);
  const failed = summarizeModelUsage([{ status: 'fail', metrics }]);
  assert.equal(failed.reportedTotalTokens, 0);
  assert.equal(failed.reportedTokensPerPassedAttempt, null);
});

test('all development outcomes run through the isolated worker and real tools without inference', { timeout: 180000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-outcome-runner-'));
  const reportPath = path.join(directory, 'report.json');
  try {
    await promisify(execFile)(process.execPath, [
      '--require', path.join(__dirname, 'fixtures/outcome-model.cjs'),
      path.join(__dirname, 'local-core-baseline.js'), '--outcomes', reportPath, 'qwen3:1.7b',
    ], { timeout: 170000, windowsHide: true });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.modelDigest, 'offline-fixture');
    assert.equal(report.results.length, 36);
    assert.equal(report.efficiency.passedAttempts, 36, JSON.stringify(report.results.filter(result => result.status !== 'pass')));
    const recordedCalls = report.results.reduce((sum, result) => sum + result.metrics.modelCalls.length, 0);
    assert.equal(report.clientUsage.recordedCalls, recordedCalls);
    assert.equal(report.clientUsage.callsWithUsage, recordedCalls);
    assert.equal(report.clientUsage.allCallsReported, true);
    assert.equal(report.clientUsage.reportedTotalTokens, recordedCalls * 18);
    assert.equal(report.clientUsage.reportedTokensPerPassedAttempt, recordedCalls * 18 / 36);
    assert.equal(report.efficiency.totalTokens, null);
    assert.equal(report.efficiency.costUsd, null);
    assert.equal(report.requestUsage.reportedTotalTokens, null);
    assert.equal(report.requestUsage.recordedCalls, 0);
    assert.equal(report.requestUsage.allCallsLinked, false);
    for (const result of report.results) {
      assert.equal(result.split, 'development');
      assert.equal(result.outcomeCheck.pass, true);
      assert.match(result.workerStderr, /offline-model-call/);
      assert.ok(result.workerExit);
      assert.ok(result.metrics.startupMs > 0);
      assert.ok(result.metrics.firstUsefulOutputMs >= result.metrics.startupMs);
      assert.ok(result.metrics.workerPeakRssKiB > 0);
      assert.ok(result.metrics.modelCalls.length >= 2);
      for (const call of result.metrics.modelCalls) {
        assert.ok(call.callId > 0);
        assert.equal(call.context.messageBytes, call.messageBytes);
        assert.equal(call.context.schemaBytes, call.schemaBytes);
        assert.equal(Object.values(call.context.byRole).reduce((sum, role) => sum + role.bytes, call.context.framingBytes), call.messageBytes);
        assert.ok(call.messageBytes > 0);
        assert.ok(call.schemaBytes > 0);
        assert.equal(call.usage.promptTokens, 12);
        assert.equal(call.usage.completionTokens, 6);
        assert.ok(call.durationMs >= 0);
      }
      assert.ok(result.evidence.events.some(event => event.type === 'done' && event.reason === 'completed'));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});