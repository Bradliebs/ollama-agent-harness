import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { resolveProjectReadPath } from './pathResolution';

const DEFAULT_MAX_CHARS = 100_000;
const MAX_ALLOWED_CHARS = 1_000_000;
export const MAX_DOCUMENT_BYTES = 25_000_000;

const SUPPORTED_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);

interface MammothModule {
  extractRawText(options: { path: string }): Promise<{ value: string }>;
}

interface JsZipFile {
  async(type: 'string'): Promise<string>;
}

interface JsZipInstance {
  files: Record<string, JsZipFile>;
}

interface JsZipModule {
  loadAsync(data: Buffer): Promise<JsZipInstance>;
}

// Force a real ESM dynamic import that survives tsc's CommonJS transpile and
// keeps these optional parsers untyped (no @types package required).
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

function clampMaxChars(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CHARS;
  return Math.max(1, Math.min(MAX_ALLOWED_CHARS, Math.floor(n)));
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

async function readDocx(filePath: string): Promise<string> {
  const mammoth = (await importModule('mammoth')) as MammothModule;
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function readXlsx(filePath: string): Promise<string> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const parts: string[] = [];
  workbook.eachSheet((worksheet) => {
    parts.push(`# Sheet: ${worksheet.name}`);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(cell.text ?? '');
      });
      parts.push(cells.join('\t'));
    });
  });
  return parts.join('\n');
}

async function readPptx(filePath: string): Promise<string> {
  const JSZip = (await importModule('jszip')) as { default: JsZipModule } | JsZipModule;
  const zipFactory = ('default' in JSZip ? JSZip.default : JSZip) as JsZipModule;
  const data = await fs.readFile(filePath);
  const zip = await zipFactory.loadAsync(data);
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const parts: string[] = [];
  for (const slidePath of slidePaths) {
    const xml = await zip.files[slidePath].async('string');
    const texts = Array.from(xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)).map((m) => decodeXmlEntities(m[1]));
    if (texts.length > 0) {
      parts.push(`# Slide ${slideNumber(slidePath)}\n${texts.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

function slideNumber(slidePath: string): number {
  const match = slidePath.match(/slide(\d+)\.xml$/);
  return match ? Number(match[1]) : 0;
}

/**
 * Reads text from Microsoft Office documents (.docx, .xlsx, .pptx) using
 * pure-JS parsers bundled at install time, so a fresh `npm install` can read
 * Office files with no extra setup. PDFs use pdf_read; plain text uses file_read.
 */
export const DocumentReadTool: Tool = {
  name: 'document_read',
  description: 'Extract text from a Microsoft Office document: Word (.docx), Excel (.xlsx), or PowerPoint (.pptx). Excel sheets are returned as tab-separated rows; PowerPoint is returned slide by slide. Use pdf_read for PDFs and file_read for plain-text files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to a .docx, .xlsx, or .pptx file (project-relative or an attachment path)' },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}, max ${MAX_ALLOWED_CHARS})` },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectReadPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory or was not provided', error: 'path outside project' };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return { success: false, output: 'document_read supports .docx, .xlsx, and .pptx. Use pdf_read for PDFs and file_read for plain-text files.', error: 'unsupported document type' };
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_DOCUMENT_BYTES) {
        return { success: false, output: `Document is ${stat.size} bytes, exceeding the ${MAX_DOCUMENT_BYTES}-byte limit.`, error: 'document too large' };
      }
      const maxChars = clampMaxChars(input.max_chars);
      let text: string;
      if (ext === '.docx') text = await readDocx(filePath);
      else if (ext === '.xlsx') text = await readXlsx(filePath);
      else text = await readPptx(filePath);

      if (!text.trim()) {
        return { success: true, output: '[no extractable text found in document]' };
      }
      const truncated = text.length > maxChars;
      const output = truncated ? `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]` : text;
      return { success: true, output };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read document: ${msg}`, error: msg };
    }
  },
};
