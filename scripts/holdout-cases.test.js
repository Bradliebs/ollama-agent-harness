const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cases, prepare, verify, validateDataset } = require('./holdout-cases');

test('holdouts are frozen and cover eight separately authored tasks', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'modernization-holdout.json'));
  assert.equal(validateDataset(bytes).length, 8);
  assert.throws(() => validateDataset(Buffer.concat([bytes, Buffer.from('\n')])), /Frozen holdout dataset changed/);
  assert.deepEqual(new Set(cases.filter(task => task.format).map(task => task.format)), new Set(['json', 'csv', 'xlsx', 'docx', 'pdf']));
  assert.equal(cases.filter(task => task.response).length, 2);
});

test('holdout preflight validates the frozen set without inference', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'local-core-baseline.js'), '--check-holdouts'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.tasks, 8);
  assert.equal(report.inferenceSent, false);
  assert.equal(report.digest, require('./holdout-cases').digest);
});

test('holdout runner records all negative-control attempts separately without inference', { timeout: 120000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-holdout-negative-'));
  const reportPath = path.join(workspace, 'report.json');
  try {
    await promisify(execFile)(process.execPath, ['--require', path.join(__dirname, 'fixtures/holdout-noop.cjs'),
      path.join(__dirname, 'local-core-baseline.js'), '--holdouts', reportPath, 'qwen3:1.7b'], { timeout: 110000, windowsHide: true });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.modelDigest, 'offline-negative-control');
    assert.equal(report.datasetDigest, require('./holdout-cases').digest);
    assert.equal(report.authorship, 'separate-agent-ai-authored');
    assert.equal(report.taskCount, 8);
    assert.equal(report.results.length, 24);
    assert.equal(report.efficiency.passedAttempts, 0);
    assert.equal(report.requestUsage.reportedTotalTokens, null);
    assert.equal(report.requestUsage.recordedCalls, 0);
    for (const task of cases) assert.equal(report.results.filter(result => result.taskId === task.id).length, 3);
    for (const result of report.results) {
      assert.equal(result.split, 'held-out-ai-authored');
      assert.equal(result.status, 'fail');
      assert.equal(result.outcomeCheck.pass, false);
      assert.ok(result.workerExit);
      assert.equal(result.metrics.modelCalls.length, 1);
      assert.equal(result.metrics.modelCalls[0].usage, null);
    }
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

for (const task of cases) {
  test(`${task.id}: validates reference artifact and rejects corruption`, async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-holdout-check-'));
    try {
      const fixtures = prepare(workspace, task);
      assert.equal((await verify(workspace, task, 'Done.', fixtures)).pass, false);
      const target = path.join(workspace, `out/result.${task.format || 'json'}`);
      if (task.format === 'json') fs.writeFileSync(target, JSON.stringify(task.expected));
      else if (task.format === 'csv') fs.writeFileSync(target, task.expected);
      else if (task.format === 'xlsx') {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet('Inventory').addRows(task.expected);
        await workbook.xlsx.writeFile(target);
      } else if (task.format === 'docx') {
        const { Document, Packer, Paragraph } = require('docx');
        const document = new Document({ sections: [{ children: [new Paragraph(task.expected)] }] });
        fs.writeFileSync(target, await Packer.toBuffer(document));
      } else if (task.format === 'pdf') {
        const PDFDocument = require('pdfkit');
        await new Promise((resolve, reject) => {
          const output = fs.createWriteStream(target);
          output.once('finish', resolve);
          output.once('error', reject);
          const document = new PDFDocument();
          document.pipe(output);
          document.text(task.expected);
          document.end();
        });
      }
      const response = JSON.stringify(task.response);
      const result = await verify(workspace, task, response, fixtures);
      assert.equal(result.pass, true, result.reason);
      if (task.format) {
        const original = fs.readFileSync(target);
        fs.writeFileSync(target, '{}');
        assert.equal((await verify(workspace, task, response, fixtures)).pass, false);
        fs.writeFileSync(target, original);
      } else assert.equal((await verify(workspace, task, '{}', fixtures)).pass, false);
      fs.writeFileSync(path.join(workspace, 'input.json'), '{}');
      assert.equal((await verify(workspace, task, response, fixtures)).pass, false);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });
}