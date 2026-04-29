/**
 * Ollama Agent Harness — Cookbook: Summarize a PDF
 *
 * Demonstrates calling the public PdfReadTool / PdfMetadataTool APIs from a
 * package consumer to extract text and metadata, then handing the extracted
 * text to a chat model for summarization.
 *
 * Run with: ts-node cookbook/pdf-summarize.ts path/to/document.pdf
 */

import { Ollama } from 'ollama';
import { PdfReadTool, PdfMetadataTool } from '../src';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: ts-node cookbook/pdf-summarize.ts <path-to.pdf>');
    process.exit(1);
  }

  const meta = await PdfMetadataTool.execute({ path: target });
  if (!meta.success) {
    console.error('Metadata read failed:', meta.error);
    process.exit(1);
  }
  console.log('--- Metadata ---');
  console.log(meta.output);

  const read = await PdfReadTool.execute({ path: target, max_chars: 20_000 });
  if (!read.success) {
    console.error('PDF read failed:', read.error);
    process.exit(1);
  }

  const model = process.env.OLLAMA_MODEL ?? 'llama3.1';
  const client = new Ollama({ host: process.env.OLLAMA_HOST ?? 'http://localhost:11434' });
  const response = await client.chat({
    model,
    stream: false,
    messages: [
      { role: 'system', content: 'Summarize the provided PDF text in 5 bullet points. Note the document title if present.' },
      { role: 'user', content: read.output },
    ],
  });

  console.log('\n--- Summary ---');
  console.log(response.message?.content ?? '(no summary returned)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
