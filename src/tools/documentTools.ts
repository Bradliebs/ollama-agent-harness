import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { applyFileWriteRedirect, maybeRedirectAgentOutput, resolveProjectPath } from './pathResolution';

type DocFormat = 'csv' | 'xlsx' | 'docx' | 'pdf';

const ALLOWED_FORMATS: DocFormat[] = ['csv', 'xlsx', 'docx', 'pdf'];

/**
 * Generates documents in CSV, Excel (.xlsx), Word (.docx), or PDF format.
 * Files are written to the project directory or configured external paths.
 */
export const DocumentExportTool: Tool = {
  name: 'document_export',
  description: 'Generate a CSV, Excel (.xlsx), Word (.docx), or PDF file. For CSV: provide rows as an array of arrays. For Excel: provide sheets with rows. For Word/PDF: provide a body array of paragraph and table elements. Paragraph: { type: "paragraph", text, heading?: 1|2|3, bold?, italic? }. Table: { type: "table", headers: string[], rows: string[][] }.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Output file path (e.g. "report.xlsx", "data.csv", "brief.docx", "summary.pdf")' },
      format: { type: 'string', description: 'Output format: csv, xlsx, docx, or pdf', enum: ['csv', 'xlsx', 'docx', 'pdf'] },
      title: { type: 'string', description: 'Document title (used in docx/pdf headers)' },
      content: {
        type: 'object',
        description: 'Document content. CSV: { rows: string[][] }. Excel: { sheets: [{ name, rows }] } or { rows }. Word/PDF: { markdown: string } or { body: [{ type: "paragraph", text, heading?, bold?, italic? }, { type: "table", headers: string[], rows: string[][] }] }. Legacy "paragraphs" array still works for backward compatibility.',
      },
    },
    required: ['path', 'format', 'content'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const rawPath = String(input.path ?? '');
    const format = String(input.format ?? '') as DocFormat;
    if (!ALLOWED_FORMATS.includes(format)) {
      return { success: false, output: `Unsupported format "${format}". Use: ${ALLOWED_FORMATS.join(', ')}`, error: 'bad format' };
    }
    // Use the same redirect chain as file_write so documents land in the
    // configured Agent Files directory (C:\AI\Oracle) instead of the project root.
    let filePath: string | null = applyFileWriteRedirect(rawPath);
    let redirectNote = filePath ? ' (redirected by pattern rule)' : '';
    if (!filePath) {
      const bareRedirect = maybeRedirectAgentOutput(rawPath);
      if (bareRedirect) {
        filePath = bareRedirect;
        redirectNote = ' (redirected to Agent Files)';
      } else {
        filePath = resolveProjectPath(rawPath);
      }
    }
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    const title = String(input.title ?? 'Document');
    const content = input.content as Record<string, unknown> | undefined;
    if (!content) {
      return { success: false, output: 'Content is required', error: 'missing content' };
    }
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      switch (format) {
        case 'csv': await writeCsv(filePath, content); break;
        case 'xlsx': await writeXlsx(filePath, title, content); break;
        case 'docx': await writeDocx(filePath, title, content); break;
        case 'pdf': await writePdf(filePath, title, content); break;
      }
      const stat = await fs.stat(filePath);
      return { success: true, output: `Wrote ${format.toUpperCase()} document (${stat.size} bytes) to '${filePath}'${redirectNote}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to write ${format}: ${msg}`, error: msg };
    }
  },
};

// ─── CSV ────────────────────────────────────────────────────────────

function escapeCsvField(value: unknown): string {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function writeCsv(filePath: string, content: Record<string, unknown>): Promise<void> {
  const rows = Array.isArray(content.rows) ? content.rows as unknown[][] : [];
  if (rows.length === 0) throw new Error('CSV content must have a "rows" array');
  const csv = rows.map((row) => {
    const cells = Array.isArray(row) ? row : [row];
    return cells.map(escapeCsvField).join(',');
  }).join('\n') + '\n';
  await fs.writeFile(filePath, csv, 'utf-8');
}

// ─── Excel (.xlsx) ──────────────────────────────────────────────────

function coerceExcelValue(raw: unknown): string | number {
  if (typeof raw === 'number') return raw;
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  // Percentage: "61%" → 0.61 (Excel native percentage)
  const pctMatch = s.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (pctMatch) return parseFloat(pctMatch[1]) / 100;
  // Currency: "£4.50", "$18.00" → 4.50 (strip symbol, keep number)
  const curMatch = s.match(/^[£$€¥]?\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?)$/);
  if (curMatch) return parseFloat(curMatch[1].replace(/,/g, ''));
  // Plain number: "12.80" → 12.8
  const num = Number(s);
  if (s !== '' && !isNaN(num) && isFinite(num)) return num;
  return s;
}

async function writeXlsx(filePath: string, title: string, content: Record<string, unknown>): Promise<void> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Harness';
  workbook.created = new Date();

  const sheets = Array.isArray(content.sheets) ? content.sheets as Array<{ name?: string; rows?: unknown[][] }> : [];
  if (sheets.length === 0) {
    const rows = Array.isArray(content.rows) ? content.rows as unknown[][] : [];
    if (rows.length === 0) throw new Error('Excel content must have "sheets" or "rows" array');
    const ws = workbook.addWorksheet(title);
    for (let i = 0; i < rows.length; i++) {
      const row = Array.isArray(rows[i]) ? rows[i] : [rows[i]];
      ws.addRow(i === 0 ? row.map((v) => String(v ?? '')) : row.map(coerceExcelValue));
    }
    styleHeaderRow(ws);
  } else {
    for (const sheet of sheets) {
      const name = String(sheet.name ?? 'Sheet');
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      const ws = workbook.addWorksheet(name);
      for (let i = 0; i < rows.length; i++) {
        const row = Array.isArray(rows[i]) ? (rows[i] as unknown[]) : [rows[i]];
        ws.addRow(i === 0 ? row.map((v) => String(v ?? '')) : row.map(coerceExcelValue));
      }
      styleHeaderRow(ws);
    }
  }

  await workbook.xlsx.writeFile(filePath);
}

function styleHeaderRow(ws: import('exceljs').Worksheet): void {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  });
  ws.columns.forEach((col) => {
    col.width = Math.max(12, Math.min(40, (col.header?.toString().length ?? 10) + 4));
  });
}

// ─── Word (.docx) ───────────────────────────────────────────────────

interface ParagraphInput {
  type?: 'paragraph';
  text?: string;
  heading?: number;
  bold?: boolean;
  italic?: boolean;
}

interface TableInput {
  type: 'table';
  headers?: string[];
  rows?: unknown[][];
}

type BodyElement = ParagraphInput | TableInput;

function parseBody(content: Record<string, unknown>): BodyElement[] {
  if (typeof content.markdown === 'string') return markdownToBody(content.markdown);
  // Prefer "body" array (new format with mixed paragraphs and tables).
  if (Array.isArray(content.body)) return content.body as BodyElement[];
  // Fall back to legacy "paragraphs" array.
  if (Array.isArray(content.paragraphs)) {
    return (content.paragraphs as ParagraphInput[]).map((p) => ({ ...p, type: 'paragraph' as const }));
  }
  return [];
}

function markdownToBody(markdown: string): BodyElement[] {
  const body: BodyElement[] = [];
  const paragraphLines: string[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  const flushParagraph = () => {
    const text = paragraphLines.join(' ').replace(/\s+/g, ' ').trim();
    paragraphLines.length = 0;
    if (text) body.push({ type: 'paragraph', text });
  };

  const parseTableRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const isTableSeparator = (line: string): boolean => parseTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      body.push({ type: 'paragraph', heading: heading[1].length, text: cleanMarkdownText(heading[2]) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flushParagraph();
      const headers = parseTableRow(line).map(cleanMarkdownText);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(parseTableRow(lines[i].trim()).map(cleanMarkdownText));
        i += 1;
      }
      i -= 1;
      body.push({ type: 'table', headers, rows });
      continue;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      body.push({ type: 'paragraph', text: `- ${cleanMarkdownText(listItem[1])}` });
      continue;
    }

    paragraphLines.push(cleanMarkdownText(line));
  }

  flushParagraph();
  return body;
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .trim();
}

async function writeDocx(filePath: string, title: string, content: Record<string, unknown>): Promise<void> {
  const docx = await import('docx');
  const body = parseBody(content);
  if (body.length === 0) throw new Error('Word content must have a "body" or "paragraphs" array');

  const children: (InstanceType<typeof docx.Paragraph> | InstanceType<typeof docx.Table>)[] = [];

  // Title
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: title, bold: true, size: 36 })],
    heading: docx.HeadingLevel.TITLE,
    spacing: { after: 200 },
  }));

  for (const element of body) {
    if (element.type === 'table') {
      const table = element as TableInput;
      const tableRows: InstanceType<typeof docx.TableRow>[] = [];
      if (table.headers && table.headers.length > 0) {
        tableRows.push(new docx.TableRow({
          tableHeader: true,
          children: table.headers.map((h) => new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text: String(h), bold: true })] })],
            shading: { type: docx.ShadingType.SOLID, color: 'E2E8F0' },
          })),
        }));
      }
      for (const row of table.rows ?? []) {
        const cells = Array.isArray(row) ? row : [row];
        tableRows.push(new docx.TableRow({
          children: cells.map((c) => new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text: String(c ?? '') })] })],
          })),
        }));
      }
      if (tableRows.length > 0) {
        children.push(new docx.Table({ rows: tableRows }));
        children.push(new docx.Paragraph({ text: '', spacing: { after: 120 } }));
      }
    } else {
      const para = element as ParagraphInput;
      const text = String(para.text ?? '');
      if (!text) continue;
      const heading = typeof para.heading === 'number' && para.heading >= 1 && para.heading <= 3
        ? ([docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3] as const)[para.heading - 1]
        : undefined;
      children.push(new docx.Paragraph({
        children: [new docx.TextRun({ text, bold: para.bold, italics: para.italic })],
        heading,
        spacing: { after: 120 },
      }));
    }
  }

  const doc = new docx.Document({
    creator: 'Harness',
    title,
    sections: [{ children }],
  });

  const buffer = await docx.Packer.toBuffer(doc);
  await fs.writeFile(filePath, buffer);
}

// ─── PDF ────────────────────────────────────────────────────────────

async function writePdf(filePath: string, title: string, content: Record<string, unknown>): Promise<void> {
  const PDFDocument = (await import('pdfkit')).default;
  const body = parseBody(content);
  if (body.length === 0) throw new Error('PDF content must have a "body" or "paragraphs" array');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Author: 'Harness' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', async () => {
      try {
        await fs.writeFile(filePath, Buffer.concat(chunks));
        resolve();
      } catch (err) { reject(err); }
    });
    doc.on('error', reject);

    // Title
    doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown();

    for (const element of body) {
      if (element.type === 'table') {
        const table = element as TableInput;
        const allRows = [...(table.headers ? [table.headers] : []), ...(table.rows ?? [])];
        if (allRows.length > 0) {
          const colCount = Math.max(...allRows.map((r) => (Array.isArray(r) ? r.length : 1)));
          const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
          const colWidth = pageWidth / colCount;

          for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
            const row = allRows[rowIdx];
            const cells = Array.isArray(row) ? row : [row];
            const isHeader = rowIdx === 0 && table.headers && table.headers.length > 0;
            const y = doc.y;
            for (let colIdx = 0; colIdx < colCount; colIdx++) {
              const x = doc.page.margins.left + colIdx * colWidth;
              doc.save();
              if (isHeader) {
                doc.rect(x, y, colWidth, 18).fill('#E2E8F0').stroke('#CBD5E1');
                doc.fillColor('#000000').fontSize(9).font('Helvetica-Bold');
              } else {
                doc.rect(x, y, colWidth, 16).stroke('#E2E8F0');
                doc.fontSize(9).font('Helvetica');
              }
              doc.text(String(cells[colIdx] ?? ''), x + 4, y + 3, { width: colWidth - 8, height: isHeader ? 16 : 14 });
              doc.restore();
            }
            doc.y = y + (isHeader ? 18 : 16);
          }
          doc.moveDown(0.5);
        }
      } else {
        const para = element as ParagraphInput;
        const text = String(para.text ?? '');
        if (!text) continue;
        if (para.heading === 1) {
          doc.fontSize(18).font('Helvetica-Bold').text(text);
        } else if (para.heading === 2) {
          doc.fontSize(15).font('Helvetica-Bold').text(text);
        } else if (para.heading === 3) {
          doc.fontSize(13).font('Helvetica-Bold').text(text);
        } else if (para.bold) {
          doc.fontSize(11).font('Helvetica-Bold').text(text);
        } else if (para.italic) {
          doc.fontSize(11).font('Helvetica-Oblique').text(text);
        } else {
          doc.fontSize(11).font('Helvetica').text(text);
        }
        doc.moveDown(0.3);
      }
    }

    doc.end();
  });
}
