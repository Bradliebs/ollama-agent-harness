import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { extractPdfText } from './pdfTool';
import type { Tool, ToolResult } from '../types';

const MAX_RESPONSE_SIZE = 50_000;
const MAX_PDF_BYTES = 50_000_000;

export const WebFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch the content of a URL and return the response body as text. PDF responses are passed through pdf_read text extraction automatically.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
    },
    required: ['url'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = input.url as string;
    const method = (input.method as string) ?? 'GET';

    try {
      const response = await fetch(url, { method, signal: AbortSignal.timeout(30_000) });
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const looksLikePdf = contentType.includes('application/pdf') || url.toLowerCase().split('?')[0].endsWith('.pdf');

      if (response.ok && looksLikePdf) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_PDF_BYTES) {
          return { success: false, output: `PDF response exceeds ${MAX_PDF_BYTES} bytes (${buffer.length}).`, error: 'pdf too large' };
        }
        const tmpPath = path.join(os.tmpdir(), `harness-webfetch-${Date.now()}.pdf`);
        try {
          await fs.writeFile(tmpPath, buffer);
          const result = await extractPdfText(buffer, { maxChars: MAX_RESPONSE_SIZE }, tmpPath);
          const header = `[PDF fetched from ${url}; pages ${result.startPage}-${result.endPage} of ${result.pageCount}]\n\n`;
          return { success: true, output: header + result.text };
        } finally {
          await fs.rm(tmpPath, { force: true });
        }
      }

      const body = await response.text();
      const truncated = body.length > MAX_RESPONSE_SIZE
        ? body.slice(0, MAX_RESPONSE_SIZE) + '\n...(truncated)'
        : body;

      if (!response.ok) {
        return {
          success: false,
          output: `HTTP ${response.status} ${response.statusText}\n${truncated}`,
          error: `HTTP ${response.status}`,
        };
      }

      return { success: true, output: truncated };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Fetch failed: ${msg}`, error: msg };
    }
  },
};
