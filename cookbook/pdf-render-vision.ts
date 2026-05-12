/**
 * Ollama Agent Harness — Cookbook: Render a PDF page and ask a vision model
 *
 * Demonstrates calling PdfRenderPageTool to rasterize a single PDF page to
 * PNG, then handing that image to a vision-capable Ollama model (e.g. llava)
 * for description.
 *
 * Prerequisite — set HARNESS_PDF_RENDER_COMMAND, for example:
 *   $env:HARNESS_PDF_RENDER_COMMAND = 'pdftoppm -png -r 150 -f {page} -l {page} "{input}" "{output}"'
 *
 * Run with:
 *   ts-node cookbook/pdf-render-vision.ts path/to/document.pdf 1
 */

import * as fs from 'fs/promises';
import { Ollama } from 'ollama';
import { PdfRenderPageTool } from '../src';

async function main(): Promise<void> {
  const target = process.argv[2];
  const page = Number(process.argv[3] ?? '1');
  if (!target) {
    console.error('Usage: ts-node cookbook/pdf-render-vision.ts <path-to.pdf> [page]');
    process.exit(1);
  }

  const render = await PdfRenderPageTool.execute({ path: target, page });
  if (!render.success) {
    console.error('Render failed:', render.output);
    process.exit(1);
  }
  // Tool output: "Rendered page N to <relative path>"
  const renderedPath = render.output.replace(/^Rendered page \d+ to /, '').trim();
  console.log('--- Rendered ---');
  console.log(renderedPath);

  const imageBytes = await fs.readFile(renderedPath);
  const model = process.env.OLLAMA_VISION_MODEL ?? 'llava';
  const client = new Ollama({ host: process.env.OLLAMA_HOST ?? 'http://localhost:11434' });
  const response = await client.chat({
    model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: `Describe page ${page} of the PDF. Call out any diagrams, tables, or figures.`,
        images: [imageBytes.toString('base64')],
      },
    ],
  });

  console.log('--- Vision Response ---');
  console.log(response.message?.content ?? '(no content)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
