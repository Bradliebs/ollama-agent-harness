const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const datasetVersion = 'development-v2';

const input = { owner: 'Mira', items: [2, 5], count: 7 };
const sources = [
  { id: 'A', fact: 'The annual pass costs 48 credits.' },
  { id: 'B', fact: 'The monthly pass costs 5 credits.' },
];
const cases = [
  { id: 'copy-record', prompt: 'Read input.json and copy its entire object to out/result.json.', format: 'json', expected: input },
  { id: 'aggregate-record', prompt: 'Read input.json and write the sum of items as {"total":number} to out/result.json.', format: 'json', expected: { total: 7 } },
  { id: 'preserve-fields', prompt: 'Read out/result.json. Set enabled to true without changing label or adding fields.', format: 'json', expected: { enabled: true, label: 'demo' } },
  { id: 'readonly-count', prompt: 'Read input.json and answer only {"value":count} as raw JSON without Markdown fences or explanation. Do not modify any files.', response: { value: 7 } },
  { id: 'absent-evidence', prompt: 'Read input.json and answer only {"value":weight} as raw JSON without Markdown fences or explanation. Use null when weight is absent. Do not modify files.', response: { value: null } },
  { id: 'source-supported-comparison', prompt: 'Read sources.json. Write out/result.json with exactly four top-level fields: annualCost, twelveMonthlyCost, savings (each a number), and sources (a flat array of supporting source IDs in their input order). Do not add facts or nested objects.', format: 'json', expected: { annualCost: 48, twelveMonthlyCost: 60, savings: 12, sources: ['A', 'B'] } },
  { id: 'csv-export', prompt: 'Read input.json. Use document_export to create out/result.csv with exactly two columns owner,count and one data row from the record.', format: 'csv', expected: 'owner,count\nMira,7\n', document: true },
  { id: 'spreadsheet-export', prompt: 'Read input.json. Use document_export to create out/result.xlsx, title Inventory, with exactly one worksheet named Inventory, header owner,count and one data row from the record.', format: 'xlsx', expected: [['owner', 'count'], ['Mira', 7]], document: true },
  { id: 'word-export', prompt: 'Read input.json. Use document_export to create out/result.docx with title Inventory and exactly one paragraph: Mira has 7 items.', format: 'docx', expected: 'Inventory Mira has 7 items.', document: true },
  { id: 'pdf-export', prompt: 'Read input.json. Use document_export to create out/result.pdf with title Inventory and exactly one paragraph: Mira has 7 items.', format: 'pdf', expected: 'Inventory Mira has 7 items.', document: true },
  { id: 'checkpoint-continuation', prompt: 'Read checkpoint.json and input.json. The first item is already processed. Continue the remaining items and write out/result.json as {"processed":[all processed values],"total":sum}. Do not repeat the completed item.', format: 'json', expected: { processed: [2, 5], total: 7 } },
  { id: 'verify-only', prompt: 'Read input.json and out/result.json. Verify whether result.total equals the sum of input.items. Answer only {"valid":boolean} as raw JSON without Markdown fences or explanation. Do not modify files.', response: { valid: true }, initial: { total: 7 } },
];
const digest = createHash('sha256').update(JSON.stringify({ datasetVersion, input, sources, cases })).digest('hex');

function prepare(workspace, task) {
  const fixtures = task.fixtures ? Object.fromEntries(Object.entries(task.fixtures).map(([name, value]) => [name, JSON.stringify(value)])) : {
    'input.json': JSON.stringify(input),
    'sources.json': JSON.stringify(sources),
    'checkpoint.json': JSON.stringify({ processed: [2], total: 2 }),
  };
  fs.mkdirSync(path.join(workspace, 'out'), { recursive: true });
  for (const [name, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(workspace, name), content);
  fs.writeFileSync(path.join(workspace, 'out/result.json'), JSON.stringify(task.initial || { enabled: false, label: 'demo' }));
  return fixtures;
}

async function verify(workspace, task, response, fixtures) {
  try {
    for (const [name, content] of Object.entries(fixtures)) assert.equal(fs.readFileSync(path.join(workspace, name), 'utf8'), content, `${name} changed`);
    const expectedFiles = new Set(['result.json', ...(task.format && task.format !== 'json' ? [`result.${task.format}`] : [])]);
    assert.deepEqual(new Set(fs.readdirSync(path.join(workspace, 'out'))), expectedFiles, 'Unexpected output files');
    if (task.response) {
      assert.deepEqual(JSON.parse(response), task.response);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, 'out/result.json'), 'utf8')), task.initial || { enabled: false, label: 'demo' });
    } else {
      const target = path.join(workspace, 'out', `result.${task.format}`);
      if (task.format !== 'json') assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, 'out/result.json'), 'utf8')), task.initial || { enabled: false, label: 'demo' });
      if (task.format === 'json') assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), task.expected);
      else if (task.format === 'csv') assert.equal(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), task.expected);
      else if (task.format === 'xlsx') {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(target);
        assert.equal(workbook.worksheets.length, 1);
        const sheet = workbook.getWorksheet('Inventory');
        assert.ok(sheet);
        assert.deepEqual(sheet.getSheetValues().slice(1).map(row => row.slice(1)), task.expected);
      } else if (task.format === 'docx') {
        const mammoth = require('mammoth');
        const extracted = await mammoth.extractRawText({ path: target });
        assert.equal(extracted.value.replace(/\s+/g, ' ').trim(), task.expected);
      } else if (task.format === 'pdf') {
        const { extractPdfText } = require('../dist/tools/pdfTool');
        const extracted = await extractPdfText(fs.readFileSync(target));
        assert.equal(extracted.pageCount, 1);
        const text = extracted.text.replace(/--- Page \d+ ---/g, '').replace(/\s+/g, ' ').trim();
        assert.equal(text.replace(/ Page 1 of 1$/, ''), task.expected);
      } else throw new Error('No verifier for output format');
    }
    return { pass: true, reason: 'Independent artifact/response and unchanged-input checks passed' };
  } catch (error) {
    return { pass: false, reason: error.message };
  }
}

module.exports = { cases, prepare, verify, datasetVersion, digest };