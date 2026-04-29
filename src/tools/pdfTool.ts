import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import type { Tool, ToolResult } from '../types';

const DEFAULT_MAX_CHARS = 100_000;
const MAX_ALLOWED_CHARS = 1_000_000;
const MAX_PDF_BYTES = 50_000_000;
const MIN_TEXT_FOR_FALLBACK = 32;

const execFileAsync = promisify(execFile);

export interface PdfExtractOptions {
  startPage?: number;
  endPage?: number;
  maxChars?: number;
  ocr?: boolean;
}

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  startPage: number;
  endPage: number;
  truncated: boolean;
  ocrUsed: boolean;
  ocrError?: string;
}

export interface PdfDocumentMetadata {
  pageCount: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  pdfVersion?: string;
  encrypted: boolean;
}

export const PdfReadTool: Tool = {
  name: 'pdf_read',
  description: 'Extract text from a local PDF file. Supports optional page range, character cap, and OCR fallback (set ocr=true; requires HARNESS_PDF_OCR_COMMAND).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to a .pdf file' },
      start_page: { type: 'number', description: 'Optional 1-based first page to extract' },
      end_page: { type: 'number', description: 'Optional 1-based last page to extract (inclusive)' },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS})` },
      ocr: { type: 'boolean', description: 'When true, run HARNESS_PDF_OCR_COMMAND if no embedded text is found' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      return { success: false, output: 'File does not have a .pdf extension', error: 'not a pdf' };
    }

    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_PDF_BYTES) {
        return { success: false, output: `PDF exceeds ${MAX_PDF_BYTES} bytes (${stat.size}).`, error: 'pdf too large' };
      }
      const data = await fs.readFile(filePath);
      const result = await extractPdfText(data, {
        startPage: numberOrUndefined(input.start_page),
        endPage: numberOrUndefined(input.end_page),
        maxChars: clampNumber(input.max_chars, 1, MAX_ALLOWED_CHARS, DEFAULT_MAX_CHARS),
        ocr: Boolean(input.ocr),
      }, filePath);

      const note = result.ocrUsed ? '\n[ocr fallback used]' : '';
      const ocrErr = result.ocrError ? `\n[ocr fallback failed: ${result.ocrError}]` : '';
      return { success: true, output: result.text + note + ocrErr };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read PDF '${filePath}': ${msg}`, error: msg };
    }
  },
};

export const PdfMetadataTool: Tool = {
  name: 'pdf_metadata',
  description: 'Read document metadata (title, author, page count, etc.) from a local PDF without extracting full text.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to a .pdf file' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      return { success: false, output: 'File does not have a .pdf extension', error: 'not a pdf' };
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_PDF_BYTES) {
        return { success: false, output: `PDF exceeds ${MAX_PDF_BYTES} bytes (${stat.size}).`, error: 'pdf too large' };
      }
      const data = await fs.readFile(filePath);
      const meta = await readPdfMetadata(data);
      return { success: true, output: JSON.stringify(meta, null, 2) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read PDF metadata '${filePath}': ${msg}`, error: msg };
    }
  },
};

export async function extractPdfText(
  data: Buffer,
  options: PdfExtractOptions = {},
  sourcePath?: string
): Promise<PdfExtractResult> {
  const maxChars = clampNumber(options.maxChars, 1, MAX_ALLOWED_CHARS, DEFAULT_MAX_CHARS);
  const pdfjs = loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const totalPages = doc.numPages;
    const start = clampPage(options.startPage, 1, totalPages, 1);
    const end = clampPage(options.endPage, start, totalPages, totalPages);

    const parts: string[] = [];
    let chars = 0;
    let truncated = false;
    let extractedAny = false;

    for (let pageNum = start; pageNum <= end; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => (typeof (item as { str?: unknown }).str === 'string' ? (item as { str: string }).str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
        if (pageText.length > 0) extractedAny = true;
        const header = `--- Page ${pageNum} ---\n`;
        const block = header + pageText + '\n';
        if (chars + block.length > maxChars) {
          parts.push(block.slice(0, Math.max(0, maxChars - chars)));
          truncated = true;
          break;
        }
        parts.push(block);
        chars += block.length;
      } finally {
        page.cleanup();
      }
    }

    let text = parts.join('\n').trim();
    if (truncated || end < totalPages) {
      const note = truncated
        ? `\n...(truncated at ${maxChars} characters; pages ${start}-${end} of ${totalPages})`
        : `\n...(showing pages ${start}-${end} of ${totalPages})`;
      text += note;
    }

    let ocrUsed = false;
    let ocrError: string | undefined;
    const needsOcr = !extractedAny || text.replace(/--- Page \d+ ---/g, '').trim().length < MIN_TEXT_FOR_FALLBACK;
    if (options.ocr && needsOcr) {
      try {
        const ocrText = await runPdfOcr(data, sourcePath);
        if (ocrText.trim().length > 0) {
          text = ocrText.length > maxChars ? ocrText.slice(0, maxChars) + `\n...(ocr output truncated at ${maxChars} characters)` : ocrText;
          ocrUsed = true;
        }
      } catch (err) {
        ocrError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!text) text = '(no extractable text found)';

    return { text, pageCount: totalPages, startPage: start, endPage: end, truncated, ocrUsed, ocrError };
  } finally {
    await doc.destroy();
  }
}

export async function readPdfMetadata(data: Buffer): Promise<PdfDocumentMetadata> {
  const pdfjs = loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const meta = await doc.getMetadata().catch(() => ({ info: {}, metadata: null }));
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    return {
      pageCount: doc.numPages,
      title: stringOrUndefined(info.Title),
      author: stringOrUndefined(info.Author),
      subject: stringOrUndefined(info.Subject),
      keywords: stringOrUndefined(info.Keywords),
      creator: stringOrUndefined(info.Creator),
      producer: stringOrUndefined(info.Producer),
      creationDate: stringOrUndefined(info.CreationDate),
      modificationDate: stringOrUndefined(info.ModDate),
      pdfVersion: stringOrUndefined(info.PDFFormatVersion),
      encrypted: Boolean((info as { IsEncrypted?: unknown }).IsEncrypted),
    };
  } finally {
    await doc.destroy();
  }
}

async function runPdfOcr(data: Buffer, sourcePath?: string): Promise<string> {
  const template = process.env.HARNESS_PDF_OCR_COMMAND;
  if (!template) {
    throw new Error('HARNESS_PDF_OCR_COMMAND is not set');
  }

  let inputPath: string;
  let cleanup: string | undefined;
  if (sourcePath) {
    inputPath = sourcePath;
  } else {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-pdf-ocr-'));
    inputPath = path.join(tmpDir, 'input.pdf');
    cleanup = tmpDir;
    await fs.writeFile(inputPath, data);
  }

  try {
    const rendered = template.replaceAll('{input}', JSON.stringify(inputPath) ?? '""');
    const tokens = rendered.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    if (tokens.length === 0) throw new Error('HARNESS_PDF_OCR_COMMAND is empty after substitution');
    const command = stripQuotes(tokens[0]!);
    const args = tokens.slice(1).map(stripQuotes);
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 10_000_000 });
    return stdout;
  } finally {
    if (cleanup) await fs.rm(cleanup, { recursive: true, force: true });
  }
}

function loadPdfjs(): typeof import('pdfjs-dist/legacy/build/pdf.js') {
  // pdfjs-dist legacy build (CJS) runs in Node without DOM. Loaded lazily so
  // module load stays cheap when the tools are unused.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pdfjs-dist/legacy/build/pdf.js');
}

function resolveProjectPath(value: unknown): string | null {
  const raw = String(value ?? '');
  const resolved = path.resolve(raw);
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function clampPage(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripQuotes(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1);
  }
  return token;
}

export interface PdfPageChunk {
  pageNum: number;
  text: string;
}

export async function* iteratePdfPages(
  data: Buffer,
  options: { startPage?: number; endPage?: number } = {}
): AsyncGenerator<PdfPageChunk> {
  const pdfjs = loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const totalPages = doc.numPages;
    const start = clampPage(options.startPage, 1, totalPages, 1);
    const end = clampPage(options.endPage, start, totalPages, totalPages);
    for (let pageNum = start; pageNum <= end; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => (typeof (item as { str?: unknown }).str === 'string' ? (item as { str: string }).str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
        yield { pageNum, text };
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
}

export const PdfRenderPageTool: Tool = {
  name: 'pdf_render_page',
  description: 'Render a PDF page to a PNG image using HARNESS_PDF_RENDER_COMMAND (template supports {input}, {page}, {output}). Useful when a vision model needs to see a diagram or scan.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to a .pdf file' },
      page: { type: 'number', description: '1-based page number to render' },
      output: { type: 'string', description: 'Optional output PNG path (project-relative). Defaults to .harness/pdf-renders/<basename>-p<page>.png' },
    },
    required: ['path', 'page'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const template = process.env.HARNESS_PDF_RENDER_COMMAND;
    if (!template) {
      return { success: false, output: 'HARNESS_PDF_RENDER_COMMAND is not set. Configure a renderer such as: pdftoppm -png -r 150 -f {page} -l {page} "{input}" "{output}"', error: 'render command not configured' };
    }
    const filePath = resolveProjectPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      return { success: false, output: 'File does not have a .pdf extension', error: 'not a pdf' };
    }
    const pageNum = Math.max(1, Math.floor(Number(input.page)));
    if (!Number.isFinite(pageNum) || pageNum < 1) {
      return { success: false, output: 'page must be a positive integer', error: 'invalid page' };
    }
    let outputPath: string;
    if (typeof input.output === 'string' && input.output.trim()) {
      const resolved = resolveProjectPath(input.output);
      if (!resolved) return { success: false, output: 'output path is outside the project directory', error: 'output outside project' };
      outputPath = resolved;
    } else {
      const baseName = path.basename(filePath, path.extname(filePath));
      outputPath = path.resolve(process.cwd(), '.harness', 'pdf-renders', `${baseName}-p${pageNum}.png`);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    try {
      const rendered = template
        .replaceAll('{input}', filePath)
        .replaceAll('{page}', String(pageNum))
        .replaceAll('{output}', outputPath);
      const tokens = rendered.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      if (tokens.length === 0) return { success: false, output: 'HARNESS_PDF_RENDER_COMMAND is empty after substitution', error: 'empty command' };
      const command = stripQuotes(tokens[0]!);
      const args = tokens.slice(1).map(stripQuotes);
      await execFileAsync(command, args, { maxBuffer: 10_000_000 });
      // Some renderers (e.g., pdftoppm) append a suffix like -1 to outputbase. Try to find a matching file.
      let finalPath = outputPath;
      try {
        await fs.access(finalPath);
      } catch {
        const dir = path.dirname(outputPath);
        const base = path.basename(outputPath, path.extname(outputPath));
        const candidates = await fs.readdir(dir).catch(() => [] as string[]);
        const match = candidates.find((f) => f.startsWith(base) && /\.(png|jpg|jpeg)$/i.test(f));
        if (match) finalPath = path.join(dir, match);
      }
      const rel = path.relative(process.cwd(), finalPath);
      return { success: true, output: `Rendered page ${pageNum} to ${rel}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to render PDF page: ${msg}`, error: msg };
    }
  },
};
