import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PdfReadTool, PdfMetadataTool, extractPdfText, readPdfMetadata } from './pdfTool';

describe('PDF tools', () => {
  const fixtureDir = path.join(process.cwd(), '.harness', 'test-fixtures', 'pdf-tool');
  const fixtureFile = path.join(fixtureDir, 'hello.pdf');
  const blankFixtureFile = path.join(fixtureDir, 'blank.pdf');

  beforeAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(fixtureFile, buildMinimalPdf('Hello PDF World', { title: 'Test Doc', author: 'Harness' }));
    await fs.writeFile(blankFixtureFile, buildMinimalPdf('', {}));
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  describe('PdfReadTool', () => {
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

  describe('PdfMetadataTool', () => {
    it('returns document metadata as JSON', async () => {
      const result = await PdfMetadataTool.execute({ path: fixtureFile });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.pageCount).toBe(1);
      expect(parsed.title).toBe('Test Doc');
      expect(parsed.author).toBe('Harness');
    });

    it('rejects non-pdf paths', async () => {
      const result = await PdfMetadataTool.execute({ path: 'package.json' });
      expect(result).toMatchObject({ success: false, error: 'not a pdf' });
    });
  });

  describe('extractPdfText helper', () => {
    it('reports page count and start/end pages', async () => {
      const data = await fs.readFile(fixtureFile);
      const result = await extractPdfText(data);
      expect(result.pageCount).toBe(1);
      expect(result.startPage).toBe(1);
      expect(result.endPage).toBe(1);
      expect(result.ocrUsed).toBe(false);
    });
  });

  describe('readPdfMetadata helper', () => {
    it('reads info dictionary fields', async () => {
      const data = await fs.readFile(fixtureFile);
      const meta = await readPdfMetadata(data);
      expect(meta.pageCount).toBe(1);
      expect(meta.title).toBe('Test Doc');
    });
  });

  describe('OCR fallback', () => {
    const previousCommand = process.env.HARNESS_PDF_OCR_COMMAND;
    const ocrOutDir = path.join(os.tmpdir(), `harness-pdf-ocr-fixture-${Date.now()}`);
    const ocrOutputFile = path.join(ocrOutDir, 'ocr-out.txt');

    beforeAll(async () => {
      await fs.mkdir(ocrOutDir, { recursive: true });
      await fs.writeFile(ocrOutputFile, 'OCR fallback recovered text');
      // Use Node itself as a deterministic OCR command; print the fixed file regardless of input.
      process.env.HARNESS_PDF_OCR_COMMAND = `node -e "process.stdout.write(require('fs').readFileSync(${JSON.stringify(ocrOutputFile)}, 'utf-8'))" {input}`;
    });

    afterAll(async () => {
      if (previousCommand === undefined) delete process.env.HARNESS_PDF_OCR_COMMAND;
      else process.env.HARNESS_PDF_OCR_COMMAND = previousCommand;
      await fs.rm(ocrOutDir, { recursive: true, force: true });
    });

    it('uses OCR when no embedded text and ocr=true', async () => {
      const result = await PdfReadTool.execute({ path: blankFixtureFile, ocr: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain('OCR fallback recovered text');
      expect(result.output).toContain('[ocr fallback used]');
    });

    it('does not invoke OCR when ocr is omitted', async () => {
      const result = await PdfReadTool.execute({ path: blankFixtureFile });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('OCR fallback recovered text');
    });
  });
});

interface PdfMetadataInput {
  title?: string;
  author?: string;
}

// Build a minimal valid PDF containing one page with the given ASCII text.
function buildMinimalPdf(text: string, meta: PdfMetadataInput): Buffer {
  const escapeText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = text.length > 0
    ? `BT /F1 24 Tf 72 720 Td (${escapeText(text)}) Tj ET`
    : 'q Q';
  const objects: string[] = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];

  const infoFields: string[] = [];
  if (meta.title) infoFields.push(`/Title (${escapeText(meta.title)})`);
  if (meta.author) infoFields.push(`/Author (${escapeText(meta.author)})`);
  const hasInfo = infoFields.length > 0;
  if (hasInfo) {
    objects.push(`6 0 obj << ${infoFields.join(' ')} >> endobj`);
  }

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
  const trailer = hasInfo
    ? `trailer << /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n`
    : `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += trailer + `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
