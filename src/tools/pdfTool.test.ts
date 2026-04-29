import * as fs from 'fs/promises';
import * as path from 'path';
import { PdfReadTool } from './pdfTool';

describe('PdfReadTool', () => {
  const fixtureDir = path.join(process.cwd(), '.harness', 'test-fixtures', 'pdf-tool');
  const fixtureFile = path.join(fixtureDir, 'hello.pdf');

  beforeAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(fixtureFile, buildMinimalPdf('Hello PDF World'));
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('rejects paths outside the project directory', async () => {
    const result = await PdfReadTool.execute({ path: path.resolve(process.cwd(), '..', 'outside.pdf') });
    expect(result).toMatchObject({ success: false, error: 'path outside project' });
  });

  it('rejects non-pdf extensions', async () => {
    const result = await PdfReadTool.execute({ path: 'package.json' });
    expect(result).toMatchObject({ success: false, error: 'not a pdf' });
  });

  it('extracts text from a small PDF', async () => {
    const result = await PdfReadTool.execute({ path: fixtureFile });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Page 1');
    expect(result.output).toContain('Hello PDF World');
  });

  it('honors max_chars truncation', async () => {
    const result = await PdfReadTool.execute({ path: fixtureFile, max_chars: 20 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('truncated');
  });
});

// Build a minimal valid PDF containing one page with the given ASCII text.
function buildMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects: string[] = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += obj + '\n';
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
