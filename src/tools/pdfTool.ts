import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import type { Tool, ToolResult } from '../types';
import { resolveProjectPath, resolveProjectReadPath } from './pathResolution';

const DEFAULT_MAX_CHARS = 100_000;
const MAX_ALLOWED_CHARS = 1_000_000;
export const MAX_PDF_BYTES = 50_000_000;
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

interface PdfjsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocumentProxy> };
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNum: number): Promise<PdfPageProxy>;
  getMetadata(): Promise<{ info?: unknown; metadata?: unknown }>;
  destroy(): Promise<void> | void;
}

interface PdfPageProxy {
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup(): void;
}

const importPdfjs = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PdfjsModule>;

class PdfNodeDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: unknown) {
    if (Array.isArray(init)) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init.map(Number) as [number, number, number, number, number, number];
    }
  }

  translate(x = 0, y = 0): PdfNodeDOMMatrix {
    const next = new PdfNodeDOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
    next.e += x;
    next.f += y;
    return next;
  }

  scale(scaleX = 1, scaleY = scaleX): PdfNodeDOMMatrix {
    const next = new PdfNodeDOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
    next.a *= scaleX;
    next.d *= scaleY;
    return next;
  }
}

class PdfNodeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

class PdfNodePath2D {
  addPath(): void { /* no-op for non-rendering PDF text extraction */ }
  arc(): void { /* no-op for non-rendering PDF text extraction */ }
  bezierCurveTo(): void { /* no-op for non-rendering PDF text extraction */ }
  closePath(): void { /* no-op for non-rendering PDF text extraction */ }
  lineTo(): void { /* no-op for non-rendering PDF text extraction */ }
  moveTo(): void { /* no-op for non-rendering PDF text extraction */ }
  quadraticCurveTo(): void { /* no-op for non-rendering PDF text extraction */ }
  rect(): void { /* no-op for non-rendering PDF text extraction */ }
}

let pdfjsModulePromise: Promise<PdfjsModule> | null = null;

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
    const filePath = resolveProjectReadPath(input.path);
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
    const filePath = resolveProjectReadPath(input.path);
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
  let pdfjs: PdfjsModule;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    return extractPdfTextFallback(data, options, sourcePath, maxChars);
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise.catch(async () => null);
  if (!doc) return extractPdfTextFallback(data, options, sourcePath, maxChars);
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
  let pdfjs: PdfjsModule;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    return readPdfMetadataFallback(data);
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise.catch(async () => null);
  if (!doc) return readPdfMetadataFallback(data);
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

async function extractPdfTextFallback(
  data: Buffer,
  options: PdfExtractOptions,
  sourcePath: string | undefined,
  maxChars: number,
): Promise<PdfExtractResult> {
  const meta = readPdfMetadataFallback(data);
  const start = clampPage(options.startPage, 1, meta.pageCount, 1);
  const end = clampPage(options.endPage, start, meta.pageCount, meta.pageCount);
  const extracted = extractLiteralPdfStrings(data).join(' ').replace(/[ \t]+/g, ' ').trim();
  let text = extracted ? `--- Page ${start} ---\n${extracted}` : '';
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n...(truncated at ${maxChars} characters; pages ${start}-${end} of ${meta.pageCount})`;
    truncated = true;
  } else if (end < meta.pageCount) {
    text += `\n...(showing pages ${start}-${end} of ${meta.pageCount})`;
  }

  let ocrUsed = false;
  let ocrError: string | undefined;
  const needsOcr = text.replace(/--- Page \d+ ---/g, '').trim().length < MIN_TEXT_FOR_FALLBACK;
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
  return { text, pageCount: meta.pageCount, startPage: start, endPage: end, truncated, ocrUsed, ocrError };
}

function readPdfMetadataFallback(data: Buffer): PdfDocumentMetadata {
  const pdf = data.toString('latin1');
  const countMatches = Array.from(pdf.matchAll(/\/Count\s+(\d+)/g)).map((match) => Number(match[1]));
  const pageMarkers = Array.from(pdf.matchAll(/\/Type\s*\/Page\b/g)).length;
  return {
    pageCount: Math.max(1, ...countMatches, pageMarkers),
    title: extractPdfInfoString(pdf, 'Title'),
    author: extractPdfInfoString(pdf, 'Author'),
    subject: extractPdfInfoString(pdf, 'Subject'),
    keywords: extractPdfInfoString(pdf, 'Keywords'),
    creator: extractPdfInfoString(pdf, 'Creator'),
    producer: extractPdfInfoString(pdf, 'Producer'),
    creationDate: extractPdfInfoString(pdf, 'CreationDate'),
    modificationDate: extractPdfInfoString(pdf, 'ModDate'),
    encrypted: /\/Encrypt\b/.test(pdf),
  };
}

function extractPdfInfoString(pdf: string, key: string): string | undefined {
  const match = new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(pdf);
  return match ? decodePdfLiteralString(match[1] ?? '') : undefined;
}

function extractLiteralPdfStrings(data: Buffer): string[] {
  const pdf = data.toString('latin1');
  const strings: string[] = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch: RegExpExecArray | null;
  while ((streamMatch = streamPattern.exec(pdf)) !== null) {
    const stream = streamMatch[1] ?? '';
    const literalPattern = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
    let literalMatch: RegExpExecArray | null;
    while ((literalMatch = literalPattern.exec(stream)) !== null) {
      strings.push(decodePdfLiteralString(literalMatch[1] ?? ''));
    }
  }
  return strings.filter((value) => value.trim().length > 0);
}

function decodePdfLiteralString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\([()\\])/g, '$1')
    .trim();
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
    const tokens = tokenizeCommandTemplate(template, { input: inputPath });
    if (tokens.length === 0) throw new Error('HARNESS_PDF_OCR_COMMAND is empty after substitution');
    const command = tokens[0]!;
    const args = tokens.slice(1);
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 10_000_000 });
    return stdout;
  } finally {
    if (cleanup) await fs.rm(cleanup, { recursive: true, force: true });
  }
}

async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsModulePromise ??= importPdfjsModule();
  try {
    return await pdfjsModulePromise;
  } catch (error) {
    pdfjsModulePromise = null;
    throw error;
  }
}

async function importPdfjsModule(): Promise<PdfjsModule> {
  setupPdfjsNodeGlobals();

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const message = args.map((arg) => String(arg)).join(' ');
    if (message.includes('Cannot load "@napi-rs/canvas" package')) return;
    if (message.includes('Cannot polyfill `DOMMatrix`')) return;
    if (message.includes('Cannot polyfill `ImageData`')) return;
    if (message.includes('Cannot polyfill `Path2D`')) return;
    originalWarn(...args);
  };
  try {
    // Version 5 publishes ESM only, so use native dynamic import even though
    // this project compiles to CommonJS.
    return await importPdfjs('pdfjs-dist/legacy/build/pdf.mjs');
  } finally {
    console.warn = originalWarn;
  }
}

function setupPdfjsNodeGlobals(): void {
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals.DOMMatrix ??= PdfNodeDOMMatrix;
  globals.ImageData ??= PdfNodeImageData;
  globals.Path2D ??= PdfNodePath2D;
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

function tokenizeCommandTemplate(template: string, replacements: Record<string, string>): string[] {
  const sentinels = Object.fromEntries(Object.keys(replacements).map((key) => [key, `__HARNESS_${key.toUpperCase()}_${Math.random().toString(36).slice(2)}__`])) as Record<string, string>;
  let rendered = template;
  for (const [key, sentinel] of Object.entries(sentinels)) {
    rendered = rendered.replaceAll(`{${key}}`, sentinel);
  }
  const rawTokens = rendered.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return rawTokens.map((token) => {
    let value = stripQuotes(token);
    for (const [key, sentinel] of Object.entries(sentinels)) {
      value = value.replaceAll(sentinel, replacements[key] ?? '');
    }
    return value;
  });
}

export interface PdfPageChunk {
  pageNum: number;
  text: string;
}

export async function* iteratePdfPages(
  data: Buffer,
  options: { startPage?: number; endPage?: number } = {}
): AsyncGenerator<PdfPageChunk> {
  const pdfjs = await loadPdfjs();
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
    const filePath = resolveProjectReadPath(input.path);
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
      const tokens = tokenizeCommandTemplate(template, { input: filePath, page: String(pageNum), output: outputPath });
      if (tokens.length === 0) return { success: false, output: 'HARNESS_PDF_RENDER_COMMAND is empty after substitution', error: 'empty command' };
      const command = tokens[0]!;
      const args = tokens.slice(1);
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

export const PdfExtractTablesTool: Tool = {
  name: 'pdf_extract_tables',
  description: 'Heuristically extract tabular data from a PDF page using pdfjs text item positions. Outputs CSV. Best on PDFs with embedded text and reasonably aligned columns.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to a .pdf file' },
      page: { type: 'number', description: '1-based page number to scan' },
      column_tolerance: { type: 'number', description: 'Pixel tolerance when grouping items into the same column (default 8)' },
      row_tolerance: { type: 'number', description: 'Pixel tolerance when grouping items into the same row (default 4)' },
    },
    required: ['path', 'page'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectReadPath(input.path);
    if (!filePath) return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    if (path.extname(filePath).toLowerCase() !== '.pdf') return { success: false, output: 'File does not have a .pdf extension', error: 'not a pdf' };
    const pageNum = Math.max(1, Math.floor(Number(input.page)));
    if (!Number.isFinite(pageNum) || pageNum < 1) return { success: false, output: 'page must be a positive integer', error: 'invalid page' };
    const colTol = Number.isFinite(Number(input.column_tolerance)) ? Number(input.column_tolerance) : 8;
    const rowTol = Number.isFinite(Number(input.row_tolerance)) ? Number(input.row_tolerance) : 4;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_PDF_BYTES) return { success: false, output: `PDF exceeds ${MAX_PDF_BYTES} bytes (${stat.size}).`, error: 'pdf too large' };
      const data = await fs.readFile(filePath);
      const csv = await extractPdfPageTableCsv(data, pageNum, { colTol, rowTol });
      if (!csv) return { success: true, output: '(no tabular content detected on this page)' };
      return { success: true, output: csv };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to extract tables: ${msg}`, error: msg };
    }
  },
};

interface PositionedItem { str: string; x: number; y: number; width: number; }

export async function extractPdfPageTableCsv(
  data: Buffer,
  pageNum: number,
  options: { colTol: number; rowTol: number }
): Promise<string> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    if (pageNum < 1 || pageNum > doc.numPages) throw new Error(`page ${pageNum} out of range (1-${doc.numPages})`);
    const page = await doc.getPage(pageNum);
    try {
      const content = await page.getTextContent();
      const items: PositionedItem[] = [];
      for (const raw of content.items as unknown[]) {
        const item = raw as { str?: unknown; transform?: number[]; width?: number };
        if (typeof item.str !== 'string' || !item.str.trim()) continue;
        const tr = item.transform;
        if (!Array.isArray(tr) || tr.length < 6) continue;
        items.push({ str: item.str, x: Number(tr[4]), y: Number(tr[5]), width: Number(item.width ?? 0) });
      }
      if (items.length === 0) return '';
      // Group into rows by y coordinate.
      const sortedY = [...items].sort((a, b) => b.y - a.y);
      const rows: PositionedItem[][] = [];
      for (const item of sortedY) {
        const lastRow = rows[rows.length - 1];
        if (lastRow && Math.abs((lastRow[0] as PositionedItem).y - item.y) <= options.rowTol) {
          lastRow.push(item);
        } else {
          rows.push([item]);
        }
      }
      // Determine column anchors from the densest row.
      const densest = rows.slice().sort((a, b) => b.length - a.length)[0] ?? rows[0]!;
      const anchors = densest.map((it) => it.x).sort((a, b) => a - b);
      // For each row, place items into nearest column.
      const csvRows: string[][] = [];
      for (const row of rows) {
        const cols: string[] = anchors.map(() => '');
        for (const item of row.sort((a, b) => a.x - b.x)) {
          let best = 0;
          let bestDist = Infinity;
          for (let i = 0; i < anchors.length; i++) {
            const dist = Math.abs((anchors[i] as number) - item.x);
            if (dist < bestDist) { bestDist = dist; best = i; }
          }
          if (bestDist <= options.colTol * 6) {
            cols[best] = (cols[best] ? cols[best] + ' ' : '') + item.str.trim();
          }
        }
        if (cols.some((c) => c.trim().length > 0)) csvRows.push(cols);
      }
      if (csvRows.length === 0) return '';
      return csvRows.map((row) => row.map(csvEscape).join(',')).join('\n');
    } finally {
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
}

function csvEscape(value: string): string {
  const v = value.replace(/\r?\n/g, ' ').trim();
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}
