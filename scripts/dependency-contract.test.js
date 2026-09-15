const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

test('mail composition preserves recipients, text and attachment without network delivery', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const result = await transport.sendMail({
    from: 'sender@example.test',
    to: 'recipient@example.test',
    cc: 'copy@example.test',
    subject: 'Local compatibility check',
    text: 'Synthetic message only.',
    attachments: [{ filename: 'report.txt', content: 'verified attachment' }],
  });
  assert.deepEqual(result.envelope.to, ['recipient@example.test', 'copy@example.test']);
  const message = result.message.toString();
  assert.match(message, /Subject: Local compatibility check/);
  assert.match(message, /Synthetic message only\./);
  assert.match(message, /filename=report.txt/);
  assert.ok(message.includes(Buffer.from('verified attachment').toString('base64')));
});

test('mail raw content cannot bypass disabled file or URL access', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true });
  await assert.rejects(transport.sendMail({ raw: { path: __filename } }), { code: 'EFILEACCESS' });
  await assert.rejects(transport.sendMail({ raw: { href: 'http://127.0.0.1:1/' } }), { code: 'EURLACCESS' });
});

test('ExcelJS conditional-format identifiers remain valid with patched UUID', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Scores');
  sheet.addRows([[1], [2], [3]]);
  sheet.addConditionalFormatting({
    ref: 'A1:A3',
    rules: [{ type: 'iconSet', iconSet: '3Stars', cfvo: [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }] }],
  });
  const buffer = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}/);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(buffer);
  assert.equal(restored.getWorksheet('Scores').getCell('A3').value, 3);
  assert.equal(restored.getWorksheet('Scores').conditionalFormattings[0].rules[0].iconSet, '3Stars');
});