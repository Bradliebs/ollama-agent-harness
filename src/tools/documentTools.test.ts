import * as fs from 'fs/promises';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { DocumentExportTool } from './documentTools';

describe('DocumentExportTool', () => {
  const tmpDir = path.join(process.cwd(), '.harness', 'test-doc-export');

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a CSV file', async () => {
    const filePath = path.join(tmpDir, 'test.csv');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'csv',
      content: { rows: [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']] },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('CSV');
    const csv = await fs.readFile(filePath, 'utf-8');
    expect(csv).toContain('Alice,30');
    expect(csv.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('escapes CSV fields with commas and quotes', async () => {
    const filePath = path.join(tmpDir, 'escaped.csv');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'csv',
      content: { rows: [['Name', 'Description'], ['Alice', 'Likes "food", travel']] },
    });
    expect(result.success).toBe(true);
    const csv = await fs.readFile(filePath, 'utf-8');
    expect(csv).toContain('"Likes ""food"", travel"');
  });

  it('writes an Excel .xlsx file', async () => {
    const filePath = path.join(tmpDir, 'test.xlsx');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'xlsx',
      title: 'Test Report',
      content: { rows: [['Product', 'Price'], ['Sausage Roll', '4.50'], ['Pizza', '18.00']] },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('XLSX');
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(100);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.getWorksheet('Test Report');
    expect(worksheet?.getCell('A1').value).toBe('Product');
    expect(worksheet?.getCell('B2').value).toBe(4.5);
    expect(worksheet?.getCell('B3').value).toBe(18);
  });

  it('writes an Excel file with multiple sheets', async () => {
    const filePath = path.join(tmpDir, 'multi.xlsx');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'xlsx',
      title: 'Multi Sheet',
      content: {
        sheets: [
          { name: 'Revenue', rows: [['Month', 'Amount'], ['Jan', '1000']] },
          { name: 'Costs', rows: [['Item', 'Cost'], ['Flour', '50']] },
        ],
      },
    });
    expect(result.success).toBe(true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Revenue', 'Costs']);
    expect(workbook.getWorksheet('Revenue')?.getCell('B2').value).toBe(1000);
    expect(workbook.getWorksheet('Costs')?.getCell('B2').value).toBe(50);
  });

  it('writes a Word .docx file', async () => {
    const filePath = path.join(tmpDir, 'test.docx');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'docx',
      title: 'Business Plan',
      content: {
        paragraphs: [
          { text: 'Executive Summary', heading: 1 },
          { text: 'This is a test document.', bold: false },
          { text: 'Key finding: everything works.', italic: true },
        ],
      },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('DOCX');
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(100);
  });

  it('writes a PDF file', async () => {
    const filePath = path.join(tmpDir, 'test.pdf');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'pdf',
      title: 'Summary Report',
      content: {
        paragraphs: [
          { text: 'Introduction', heading: 1 },
          { text: 'This report covers the test results.' },
          { text: 'Conclusion', heading: 2 },
          { text: 'All tests passed.', bold: true },
        ],
      },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('PDF');
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(100);
  });

  it('rejects unsupported format', async () => {
    const result = await DocumentExportTool.execute({
      path: path.join(tmpDir, 'test.doc'),
      format: 'doc',
      content: { paragraphs: [{ text: 'hello' }] },
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Unsupported format');
  });

  it('rejects missing content', async () => {
    const result = await DocumentExportTool.execute({
      path: path.join(tmpDir, 'test.csv'),
      format: 'csv',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Content is required');
  });

  it('writes a Word file with tables', async () => {
    const filePath = path.join(tmpDir, 'table.docx');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'docx',
      title: 'Report with Table',
      content: {
        body: [
          { type: 'paragraph', text: 'Cost Breakdown', heading: 1 },
          { type: 'table', headers: ['Product', 'Cost', 'Price'], rows: [['Sausage Roll', '2.79', '4.50'], ['Pizza', '12.80', '20.00']] },
          { type: 'paragraph', text: 'All prices in GBP.' },
        ],
      },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('DOCX');
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(100);
  });

  it('writes a PDF file with tables', async () => {
    const filePath = path.join(tmpDir, 'table.pdf');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'pdf',
      title: 'Report with Table',
      content: {
        body: [
          { type: 'paragraph', text: 'Revenue Summary', heading: 1 },
          { type: 'table', headers: ['Month', 'Revenue', 'Profit'], rows: [['Jan', '2400', '900'], ['Feb', '2800', '1100']] },
          { type: 'paragraph', text: 'Figures are projections.' },
        ],
      },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('PDF');
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(100);
  });

  it('supports legacy paragraphs array for backward compatibility', async () => {
    const filePath = path.join(tmpDir, 'legacy.docx');
    const result = await DocumentExportTool.execute({
      path: filePath,
      format: 'docx',
      title: 'Legacy Format',
      content: {
        paragraphs: [
          { text: 'Hello', heading: 1 },
          { text: 'This uses the old format.' },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});
