const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cases, prepare, verify, datasetVersion, digest } = require('./outcome-cases');

test('development revision is identified separately from the frozen holdouts', () => {
  assert.equal(datasetVersion, 'development-v2');
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(require('./holdout-cases').digest, 'f8fed212d865078123ba858bf7b4b236732cefda137e0d95f5d4d78bff1a6291');
});

test('raw JSON response contracts still reject fenced correct values', async () => {
  for (const task of cases.filter(candidate => candidate.response)) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-raw-json-'));
    try {
      const fixtures = prepare(workspace, task);
      const response = JSON.stringify(task.response);
      assert.equal((await verify(workspace, task, response, fixtures)).pass, true);
      assert.equal((await verify(workspace, task, `\u0060\u0060\u0060json\n${response}\n\u0060\u0060\u0060`, fixtures)).pass, false);
      assert.equal((await verify(workspace, task, `Result: ${response}`, fixtures)).pass, false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('comparison contract rejects correct amounts with a nested source map', async () => {
  const task = cases.find(candidate => candidate.id === 'source-supported-comparison');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-source-contract-'));
  try {
    const fixtures = prepare(workspace, task);
    fs.writeFileSync(path.join(workspace, 'out/result.json'), JSON.stringify({
      ...task.expected, sources: { annualCost: ['A'], twelveMonthlyCost: ['B'], savings: ['A', 'B'] },
    }));
    assert.equal((await verify(workspace, task, '', fixtures)).pass, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('spreadsheet contract rejects correct cells on the wrong named sheet', async () => {
  const task = cases.find(candidate => candidate.id === 'spreadsheet-export');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sheet-contract-'));
  try {
    const fixtures = prepare(workspace, task);
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRows(task.expected);
    const target = path.join(workspace, 'out/result.xlsx');
    await workbook.xlsx.writeFile(target);
    assert.equal((await verify(workspace, task, '', fixtures)).pass, false);
    sheet.name = 'Inventory';
    await workbook.xlsx.writeFile(target);
    assert.equal((await verify(workspace, task, '', fixtures)).pass, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

for (const task of cases) {
  test(`${task.id}: accepts the required outcome and rejects wrong output or changed input`, async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-outcome-check-'));
    try {
      const fixtures = prepare(workspace, task);
      assert.equal((await verify(workspace, task, 'Done.', fixtures)).pass, false);
      if (task.format === 'json') fs.writeFileSync(path.join(workspace, 'out/result.json'), JSON.stringify(task.expected));
      else if (task.format === 'csv') fs.writeFileSync(path.join(workspace, 'out/result.csv'), task.expected);
      else if (task.format === 'xlsx') {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet('Inventory').addRows(task.expected);
        await workbook.xlsx.writeFile(path.join(workspace, 'out/result.xlsx'));
      } else if (task.format === 'docx') {
        const { Document, Packer, Paragraph } = require('docx');
        const document = new Document({ sections: [{ children: [new Paragraph('Inventory'), new Paragraph('Mira has 7 items.')] }] });
        fs.writeFileSync(path.join(workspace, 'out/result.docx'), await Packer.toBuffer(document));
      } else if (task.format === 'pdf') {
        const PDFDocument = require('pdfkit');
        await new Promise((resolve, reject) => {
          const output = fs.createWriteStream(path.join(workspace, 'out/result.pdf'));
          output.once('finish', resolve);
          output.once('error', reject);
          const document = new PDFDocument();
          document.pipe(output);
          document.text('Inventory').text('Mira has 7 items.');
          document.end();
        });
      }
      const response = JSON.stringify(task.response);
      const valid = await verify(workspace, task, response, fixtures);
      assert.equal(valid.pass, true, valid.reason);
      if (task.format) {
        const target = path.join(workspace, `out/result.${task.format}`);
        const original = fs.readFileSync(target);
        fs.writeFileSync(target, '{}');
        assert.equal((await verify(workspace, task, response, fixtures)).pass, false);
        fs.writeFileSync(target, original);
      } else assert.equal((await verify(workspace, task, '{}', fixtures)).pass, false);
      fs.writeFileSync(path.join(workspace, 'input.json'), '{}');
      assert.equal((await verify(workspace, task, response, fixtures)).pass, false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}