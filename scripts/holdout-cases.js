const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepare, verify } = require('./outcome-cases');

const digest = 'f8fed212d865078123ba858bf7b4b236732cefda137e0d95f5d4d78bff1a6291';

function validateDataset(bytes) {
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest, 'Frozen holdout dataset changed; do not tune it to candidate results');
  const dataset = JSON.parse(bytes.toString('utf8'));
  assert.equal(dataset.schemaVersion, 1);
  assert.equal(dataset.authorship, 'separate-agent-ai-authored');
  assert.equal(dataset.tasks.length, 8);
  assert.equal(new Set(dataset.tasks.map(task => task.id)).size, 8);
  for (const task of dataset.tasks) {
    assert.match(task.id, /^holdout-/);
    assert.equal(typeof task.prompt, 'string');
    assert.ok(Object.hasOwn(task.fixtures, 'input.json'));
    assert.ok(Object.keys(task.fixtures).every(name => ['input.json', 'sources.json', 'checkpoint.json'].includes(name)));
    assert.notEqual(Object.hasOwn(task, 'response'), Object.hasOwn(task, 'expected'));
    if (!task.response) assert.ok(['json', 'csv', 'xlsx', 'docx', 'pdf'].includes(task.format));
  }
  return dataset.tasks;
}

const cases = validateDataset(fs.readFileSync(path.join(__dirname, 'fixtures', 'modernization-holdout.json')));
module.exports = { cases, digest, prepare, verify, validateDataset };