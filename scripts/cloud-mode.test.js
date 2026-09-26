const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateModelRoute } = require('./local-core-baseline');

const cloudModel = { name: 'fixture:cloud', remote_host: 'https://ollama.com:443', remote_model: 'fixture' };
const localModel = { name: 'qwen3:1.7b' };

test('default mode preserves the local-only allowlist and rejects remote routes', () => {
  assert.doesNotThrow(() => validateModelRoute(localModel.name, localModel));
  assert.throws(() => validateModelRoute(cloudModel.name, cloudModel), /local model/);
  assert.throws(() => validateModelRoute(localModel.name, { ...cloudModel, name: localModel.name }), /local model/);
  assert.throws(() => validateModelRoute('other:local', { name: 'other:local' }), /local model/);
});

test('cloud mode requires matching installed remote metadata, not a cloud suffix', () => {
  assert.doesNotThrow(() => validateModelRoute(cloudModel.name, cloudModel, true));
  assert.doesNotThrow(() => validateModelRoute('alias', { ...cloudModel, name: 'alias', remote_host: 'https://ollama.com' }, true));
  assert.throws(() => validateModelRoute(localModel.name, localModel, true), /cloud destination/);
  assert.throws(() => validateModelRoute('missing', undefined, true), /unavailable/);
  assert.throws(() => validateModelRoute('different', cloudModel, true), /unavailable/);
  assert.throws(() => validateModelRoute(cloudModel.name, { name: cloudModel.name }, true), /cloud destination/);
});

test('cloud mode rejects missing remote names and non-Ollama destinations', () => {
  for (const remote_host of ['http://ollama.com', 'https://ollama.com.evil.example', 'http://127.0.0.1:11434', 'https://user@ollama.com', 'invalid']) {
    assert.throws(() => validateModelRoute(cloudModel.name, { ...cloudModel, remote_host }, true), /cloud destination/);
  }
  for (const remote_model of [undefined, '', ' ', 42]) {
    assert.throws(() => validateModelRoute(cloudModel.name, { ...cloudModel, remote_model }, true), /remote model/);
  }
});

test('cloud CLI refuses an omitted model before discovery or inference', () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, 'local-core-baseline.js'), '--cloud', '--outcomes', 'unused.json'], {
    encoding: 'utf8', stdio: 'pipe', timeout: 5000,
  }), error => error.status === 1 && /explicit model name/.test(error.stderr));
});

test('cloud worker rejects local metadata before invoking the client', () => {
  assert.throws(() => execFileSync(process.execPath, [
    '--require', path.join(__dirname, 'fixtures/outcome-model.cjs'),
    path.join(__dirname, 'local-core-baseline.js'), '--cloud', '--worker', Buffer.from('Reply with OK.').toString('base64'), 'core', 'qwen3:1.7b',
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }), error => error.status === 1
    && /cloud destination/.test(error.stderr) && !error.stderr.includes('offline-model-call'));
});

test('cloud runner propagates opt-in to all workers and labels reports without live inference', { timeout: 180000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cloud-runner-'));
  const reportPath = path.join(directory, 'report.json');
  try {
    await promisify(execFile)(process.execPath, [
      '--require', path.join(__dirname, 'fixtures/outcome-model.cjs'),
      path.join(__dirname, 'local-core-baseline.js'), '--cloud', '--outcomes', reportPath, 'fixture:cloud',
    ], { timeout: 170000, windowsHide: true });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.inferenceMode, 'ollama-cloud');
    assert.equal(report.model, 'fixture:cloud');
    assert.equal(report.modelDigest, 'offline-cloud-fixture');
    assert.equal(report.remoteHost, 'https://ollama.com');
    assert.equal(report.remoteModel, 'fixture');
    assert.equal(report.datasetVersion, 'development-v2');
    assert.equal(report.datasetDigest, require('./outcome-cases').digest);
    assert.equal(report.authorship, 'development-self-authored');
    assert.match(report.qualificationLimit, /not local GPU performance/);
    assert.equal(report.results.length, 36);
    assert.equal(report.efficiency.passedAttempts, 36);
    assert.equal(report.perTaskTimeoutMs, 60000);
    assert.equal(report.plannedReplicates, 3);
    for (const result of report.results) {
      assert.equal(result.split, 'development');
      assert.equal(result.outcomeCheck.pass, true);
      assert.match(result.workerStderr, /offline-cloud-discovery/);
      assert.ok(result.workerStderr.indexOf('offline-cloud-discovery') < result.workerStderr.indexOf('offline-model-call'));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});