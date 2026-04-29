import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

const DEFAULT_MAX_CHARS = 100_000;
const MAX_ALLOWED_CHARS = 1_000_000;
const MAX_PDF_BYTES = 50_000_000;

export const PdfReadTool: Tool = {
  name: 'pdf_read',
  description: 'Extract text from a local PDF file. Supports optional page range and character cap.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to a .pdf file' },
      start_page: { type: 'number', description: 'Optional 1-based first page to extract' },
      end_page: { type: 'number', description: 'Optional 1-based last page to extract (inclusive)' },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS})` },
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

    const maxChars = clampNumber(input.max_chars, 1, MAX_ALLOWED_CHARS, DEFAULT_MAX_CHARS);

    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_PDF_BYTES) {
        return { success: false, output: `PDF exceeds ${MAX_PDF_BYTES} bytes (${stat.size}).`, error: 'pdf too large' };
      }
      const data = await fs.readFile(filePath);
      const text = await extractPdfText(data, input.start_page, input.end_page, maxChars);
      return { success: true, output: text };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read PDF '${filePath}': ${msg}`, error: msg };
    }
  },
};

async function extractPdfText(
  data: Buffer,
  startValue: unknown,
  endValue: unknown,
  maxChars: number
): Promise<string> {
  // pdfjs-dist legacy build (CJS) runs in Node without DOM. Loaded lazily so
  // module load stays cheap when the tool is unused.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.js') = require('pdfjs-dist/legacy/build/pdf.js');
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
    const start = clampPage(startValue, 1, totalPages, 1);
    const end = clampPage(endValue, start, totalPages, totalPages);

    const parts: string[] = [];
    let chars = 0;
    let truncated = false;

    for (let pageNum = start; pageNum <= end; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => (typeof (item as { str?: unknown }).str === 'string' ? (item as { str: string }).str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
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

    let output = parts.join('\n').trim();
    if (truncated || end < totalPages) {
      const note = truncated
        ? `\n...(truncated at ${maxChars} characters; pages ${start}-${end} of ${totalPages})`
        : `\n...(showing pages ${start}-${end} of ${totalPages})`;
      output += note;
    }
    return output || '(no extractable text found)';
  } finally {
    await doc.destroy();
  }
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
