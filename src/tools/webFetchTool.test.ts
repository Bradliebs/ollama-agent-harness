import { WebFetchTool } from './webFetchTool';

describe('WebFetchTool PDF passthrough', () => {
  jest.setTimeout(30000);
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extracts text when the response is a PDF', async () => {
    const pdfBuffer = buildMinimalPdf('Hello WebFetch PDF');
    globalThis.fetch = (async () => new Response(pdfBuffer, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })) as unknown as typeof fetch;

    const result = await WebFetchTool.execute({ url: 'https://example.com/doc.pdf' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('[PDF fetched from https://example.com/doc.pdf');
    expect(result.output).toContain('Hello WebFetch PDF');
  });

  it('detects PDFs by .pdf URL even when content-type is generic', async () => {
    const pdfBuffer = buildMinimalPdf('URL-detected PDF');
    globalThis.fetch = (async () => new Response(pdfBuffer, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })) as unknown as typeof fetch;

    const result = await WebFetchTool.execute({ url: 'https://example.com/whitepaper.pdf?v=2' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('URL-detected PDF');
  });

  it('falls back to text body for non-PDF responses', async () => {
    globalThis.fetch = (async () => new Response('hello world', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch;

    const result = await WebFetchTool.execute({ url: 'https://example.com/file.txt' });

    expect(result).toMatchObject({ success: true, output: 'hello world' });
  });

  it('surfaces HTTP errors for non-2xx responses', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;

    const result = await WebFetchTool.execute({ url: 'https://example.com/missing' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 404');
  });
});

function buildMinimalPdf(text: string): Buffer {
  const escapeText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 24 Tf 72 720 Td (${escapeText(text)}) Tj ET`;
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
