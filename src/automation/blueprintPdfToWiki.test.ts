/**
 * Tests for the PDF → wiki blueprint.
 *
 * Generates a tiny multi-chapter PDF on the fly using pdfkit (already a
 * direct dependency), runs the blueprint, and asserts that the wiki +
 * chat page artifacts exist with sensible content.
 *
 * The RAG build is skipped here so the test stays hermetic and fast —
 * the RAG layer has its own coverage in src/persistence/ragIndex.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBlueprint,
  detectChapters,
  type Chapter,
} from '../../cookbook/blueprint-pdf-to-wiki';

async function makeSamplePdf(filePath: string): Promise<void> {
  // pdfkit ships as CommonJS; require keeps types simple.
  const PDFDocument = require('pdfkit');
  const { createWriteStream } = await import('node:fs');
  await new Promise<void>((resolveFn, rejectFn) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = createWriteStream(filePath);
    stream.on('finish', () => resolveFn());
    stream.on('error', rejectFn);
    doc.pipe(stream);

    doc.fontSize(20).text('Chapter 1: Introduction', { align: 'left' });
    doc.moveDown().fontSize(12).text(
      'This is the introduction. The harness is a local agent runtime. ' +
      'It composes deterministic primitives and probabilistic models.',
    );

    doc.addPage();
    doc.fontSize(20).text('Chapter 2: Architecture');
    doc.moveDown().fontSize(12).text(
      'The architecture is layered. At the bottom sit tools. Above tools sit agents. ' +
      'Above agents sit workflows. The autonomy loop coordinates the whole stack.',
    );

    doc.addPage();
    doc.fontSize(20).text('Chapter 3: Operations');
    doc.moveDown().fontSize(12).text(
      'Operating the harness in production requires monitoring of token spend, latency, ' +
      'and tool failure rates. The daily brief surfaces all three.',
    );

    doc.end();
  });
}

describe('detectChapters', () => {
  it('finds chapters from "Chapter N" headings', () => {
    const text = [
      '--- Page 1 ---',
      'Chapter 1: Introduction',
      'Some intro body.',
      '--- Page 2 ---',
      'Chapter 2: Architecture',
      'Architecture body.',
      '--- Page 3 ---',
      'Chapter 3: Operations',
      'Operations body.',
    ].join('\n');
    const chapters = detectChapters(text);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]).toMatchObject({ number: 1, startPage: 1 });
    expect(chapters[0].title).toMatch(/Introduction/);
    expect(chapters[2]).toMatchObject({ number: 3, startPage: 3 });
  });

  it('falls back to page-range buckets when no headings are found', () => {
    const text = [
      '--- Page 1 ---', 'no headings here', '--- Page 2 ---', 'still nothing',
      '--- Page 3 ---', 'just text', '--- Page 4 ---', 'just text',
    ].join('\n');
    const chapters = detectChapters(text, { fallbackChunks: 2 });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].startPage).toBe(1);
    expect(chapters[1].endPage).toBe(4);
    expect(chapters[0].slug).toMatch(/^01-pages-/);
  });

  it('always returns at least one chapter', () => {
    const chapters = detectChapters('--- Page 1 ---\nhello world');
    expect(chapters.length).toBeGreaterThanOrEqual(1);
  });

  it('dedupes repeated heading text across pages (PDF page-header noise)', () => {
    const text = [
      '--- Page 1 ---',
      'Chapter 1: Intro',
      'body',
      '--- Page 2 ---',
      'Chapter 1: Intro',
      'more body',
      '--- Page 3 ---',
      'Chapter 2: Next',
      'next body',
    ].join('\n');
    const chapters: Chapter[] = detectChapters(text);
    // Should not double-count the repeated "Chapter 1: Intro" heading.
    const intros = chapters.filter((c) => /Intro/i.test(c.title));
    expect(intros.length).toBeLessThanOrEqual(1);
  });
});

describe('buildBlueprint (end-to-end with real PDF)', () => {
  let workDir: string;
  let pdfPath: string;
  let outDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'blueprint-pdf-'));
    pdfPath = join(workDir, 'sample.pdf');
    outDir = join(workDir, 'out');
    await makeSamplePdf(pdfPath);
  }, 30_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('produces index.html, chat.html and per-chapter pages', async () => {
    const result = await buildBlueprint(pdfPath, outDir, { skipRag: true });

    // Either heading detection found 3 chapters OR fallback bucketed
    // pages — either way we want at least 1 chapter and matching files.
    expect(result.chapters.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(result.files.index)).toBe(true);
    expect(existsSync(result.files.chat)).toBe(true);
    for (const f of result.files.chapters) {
      expect(existsSync(f)).toBe(true);
    }

    const indexHtml = readFileSync(result.files.index, 'utf-8');
    expect(indexHtml).toContain('<!doctype html>');
    expect(indexHtml).toMatch(/sample\.pdf/);
    // Index links to every chapter page
    for (const c of result.chapters) {
      expect(indexHtml).toContain(`./chapters/${c.slug}.html`);
    }
    // Index links to chat
    expect(indexHtml).toContain('./chat.html');

    const chatHtml = readFileSync(result.files.chat, 'utf-8');
    expect(chatHtml).toContain('/api/rag/search');
    expect(chatHtml).toContain(result.ragIndexName);

    const firstChapterHtml = readFileSync(result.files.chapters[0], 'utf-8');
    expect(firstChapterHtml).toContain('<h1>');
  }, 30_000);

  it('is idempotent: re-running over the same input rewrites in place', async () => {
    const r1 = await buildBlueprint(pdfPath, outDir, { skipRag: true });
    const sizeBefore = readFileSync(r1.files.index).length;
    const r2 = await buildBlueprint(pdfPath, outDir, { skipRag: true });
    const sizeAfter = readFileSync(r2.files.index).length;
    expect(r2.chapters.length).toBe(r1.chapters.length);
    expect(sizeAfter).toBe(sizeBefore);
  }, 30_000);

  it('throws a clear error when the PDF is missing', async () => {
    await expect(buildBlueprint(join(workDir, 'does-not-exist.pdf'), outDir, { skipRag: true })).rejects.toThrow(/PDF not found/);
  });
});
