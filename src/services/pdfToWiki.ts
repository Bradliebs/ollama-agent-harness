/**
 * pdfToWiki.ts — PDF → wiki pipeline (compiled).
 *
 * Apex-style one-shot demo: hand it a PDF, walk away, come back to a
 * browsable wiki + a RAG index + a tiny self-contained chat page that
 * queries the index. No new domain logic — pure composition of the
 * harness's existing primitives (extractPdfText + ragIndex.build +
 * ragIndex.search + a Markdown renderer).
 *
 * Pipeline:
 *   1. extractPdfText(buffer)              → page-tagged text
 *   2. detectChapters(text)                → chapter[] (uses page anchors)
 *   3. writeChapterPages(chapters, outDir) → out/chapters/*.html
 *   4. ragIndex.build over chapter pages    → out/.harness/rag/<name>.json
 *   5. writeWikiIndex(outDir)              → out/index.html
 *   6. writeChatPage(outDir)               → out/chat.html (uses /api/rag/search)
 *
 * Idempotent: running twice over the same PDF rewrites everything in
 * place without duplicating.
 *
 * This lives under src/ (not cookbook/) so it compiles into dist/ and can
 * be loaded by the production server (`npm run serve`). The cookbook recipe
 * `cookbook/blueprint-pdf-to-wiki.ts` re-exports from here and adds a
 * standalone CLI wrapper.
 *
 * Environment:
 *   OLLAMA_HOST   — embeddings server (default http://localhost:11434)
 *   HARNESS_RAG_BACKEND — "ollama" or "hash" (default: auto-detect)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

import { extractPdfText } from '../tools/pdfTool';
import * as ragIndex from '../persistence/ragIndex';

// ─── Types ──────────────────────────────────────────────────────────

export interface Chapter {
  /** 1-based chapter number. */
  number: number;
  /** Slug for filename (e.g. "01-introduction"). */
  slug: string;
  /** Display title (best-effort from text heuristics). */
  title: string;
  /** First and last page number the chapter spans. */
  startPage: number;
  endPage: number;
  /** Raw extracted text for the chapter (page headers removed). */
  body: string;
}

export interface BlueprintResult {
  outputDir: string;
  chapters: Chapter[];
  ragIndexName: string;
  files: {
    index: string;
    chat: string;
    chapters: string[];
    ragIndex: string;
  };
}

// ─── Chapter detection ──────────────────────────────────────────────

/**
 * Detect chapters in extracted PDF text. Strategy (in priority order):
 *   1. Headings that match "Chapter N" or "CHAPTER N" on a line.
 *   2. Markdown-style H1/H2 lines (# or ##).
 *   3. ALL-CAPS lines of 4–80 chars on their own (likely titles).
 *   4. Fallback: split into N equal page-range buckets.
 *
 * Always returns at least one chapter so downstream consumers don't
 * have to handle the empty case.
 */
export function detectChapters(extracted: string, opts: { fallbackChunks?: number } = {}): Chapter[] {
  const fallbackChunks = opts.fallbackChunks ?? 6;
  const pageMarker = /^--- Page (\d+) ---$/m;

  // Walk the text page-by-page to keep track of which page each line came from.
  const lines = extracted.split(/\r?\n/);
  let currentPage = 1;
  type Hit = { line: number; page: number; raw: string; title: string };
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pageMatch = line.match(pageMarker);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Pattern 1: "Chapter N" / "CHAPTER N: Title"
    let m = trimmed.match(/^chapter\s+([0-9ivxlcdm]+)[\s:.\-]*(.*)$/i);
    if (m) {
      const num = m[1];
      const title = (m[2] || `Chapter ${num}`).trim().slice(0, 80);
      hits.push({ line: i, page: currentPage, raw: line, title });
      continue;
    }
    // Pattern 2: Markdown H1/H2
    m = trimmed.match(/^#{1,2}\s+(.+)$/);
    if (m) {
      hits.push({ line: i, page: currentPage, raw: line, title: m[1].trim().slice(0, 80) });
      continue;
    }
    // Pattern 3: ALL-CAPS short line (likely title)
    if (trimmed.length >= 4 && trimmed.length <= 80 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
      hits.push({ line: i, page: currentPage, raw: line, title: titleCase(trimmed) });
    }
  }

  // Dedupe near-duplicate titles. PDFs often repeat the chapter heading
  // as a running header on every page (or on the chapter's title page
  // and the next content page). Drop a hit when the previous hit had
  // the same title AND was on the same or adjacent page.
  const deduped: Hit[] = [];
  for (const h of hits) {
    const last = deduped[deduped.length - 1];
    if (last && last.title.toLowerCase() === h.title.toLowerCase() && h.page - last.page <= 1) continue;
    deduped.push(h);
  }

  let chapters: Chapter[] = [];

  if (deduped.length >= 2) {
    for (let i = 0; i < deduped.length; i++) {
      const start = deduped[i];
      const end = deduped[i + 1];
      const endLine = end ? end.line : lines.length;
      const body = sliceBody(lines, start.line + 1, endLine);
      const startPage = start.page;
      const endPage = end ? Math.max(start.page, end.page - 1) : extractMaxPage(extracted) ?? start.page;
      chapters.push({
        number: i + 1,
        slug: `${String(i + 1).padStart(2, '0')}-${slugify(start.title)}`,
        title: start.title,
        startPage,
        endPage,
        body,
      });
    }
  }

  if (chapters.length === 0) {
    // Fallback: split by equal page ranges.
    const maxPage = extractMaxPage(extracted) ?? 1;
    const buckets = Math.min(fallbackChunks, Math.max(1, maxPage));
    const perBucket = Math.ceil(maxPage / buckets);
    for (let i = 0; i < buckets; i++) {
      const startPage = i * perBucket + 1;
      const endPage = Math.min((i + 1) * perBucket, maxPage);
      const body = extractPageRange(lines, startPage, endPage);
      const title = `Pages ${startPage}–${endPage}`;
      chapters.push({
        number: i + 1,
        slug: `${String(i + 1).padStart(2, '0')}-pages-${startPage}-${endPage}`,
        title,
        startPage,
        endPage,
        body,
      });
    }
  }

  return chapters;
}

function extractMaxPage(extracted: string): number | undefined {
  let max: number | undefined;
  for (const m of extracted.matchAll(/^--- Page (\d+) ---$/gm)) {
    const n = parseInt(m[1], 10);
    if (!max || n > max) max = n;
  }
  return max;
}

function extractPageRange(lines: string[], startPage: number, endPage: number): string {
  const out: string[] = [];
  let current = 0;
  for (const line of lines) {
    const pm = line.match(/^--- Page (\d+) ---$/);
    if (pm) { current = parseInt(pm[1], 10); continue; }
    if (current >= startPage && current <= endPage) out.push(line);
  }
  return out.join('\n').trim();
}

function sliceBody(lines: string[], from: number, to: number): string {
  return lines.slice(from, to).filter((l) => !/^--- Page \d+ ---$/.test(l)).join('\n').trim();
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chapter';
}

function titleCase(s: string): string {
  return s.toLowerCase().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ─── HTML rendering ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chapterToHtml(chapter: Chapter, sourceName: string, prev?: Chapter, next?: Chapter): string {
  const paragraphs = chapter.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const navLinks: string[] = [`<a href="./index.html">← Index</a>`];
  if (prev) navLinks.push(`<a href="./${prev.slug}.html">← ${escapeHtml(prev.title)}</a>`);
  if (next) navLinks.push(`<a href="./${next.slug}.html">${escapeHtml(next.title)} →</a>`);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(chapter.title)} — ${escapeHtml(sourceName)}</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{margin-bottom:.25rem}.meta{color:#666;font-size:.9em;margin-bottom:2rem}
nav{display:flex;gap:1rem;margin:1rem 0;padding:.5rem 0;border-top:1px solid #ddd;border-bottom:1px solid #ddd;font-size:.9em}
nav a{text-decoration:none;color:#0066cc}p{margin:1em 0}
</style></head><body>
<nav>${navLinks.join(' · ')}</nav>
<h1>${escapeHtml(chapter.title)}</h1>
<div class="meta">Chapter ${chapter.number} · pages ${chapter.startPage}–${chapter.endPage}</div>
${paragraphs}
<nav>${navLinks.join(' · ')}</nav>
</body></html>`;
}

function indexToHtml(chapters: Chapter[], sourceName: string, totalPages: number): string {
  const items = chapters
    .map((c) => `<li><a href="./chapters/${c.slug}.html"><strong>${escapeHtml(c.title)}</strong></a> <span class="pages">pages ${c.startPage}–${c.endPage}</span></li>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(sourceName)} — Wiki</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{margin-bottom:.25rem}.meta{color:#666;font-size:.9em;margin-bottom:2rem}
ul{list-style:none;padding:0}li{padding:.5rem 0;border-bottom:1px solid #eee}
.pages{color:#888;font-size:.85em;margin-left:.5em}
a{text-decoration:none;color:#0066cc}a:hover{text-decoration:underline}
.chat-link{display:inline-block;margin-top:1rem;padding:.5rem 1rem;background:#0066cc;color:#fff;border-radius:4px}
</style></head><body>
<h1>${escapeHtml(sourceName)}</h1>
<div class="meta">${chapters.length} chapter${chapters.length === 1 ? '' : 's'} · ${totalPages} page${totalPages === 1 ? '' : 's'}</div>
<a class="chat-link" href="./chat.html">💬 Ask the wiki</a>
<h2>Contents</h2>
<ul>${items}</ul>
</body></html>`;
}

function chatToHtml(sourceName: string, indexName: string): string {
  // Self-contained: queries the harness's /api/rag/search on the same
  // host. Falls back to a helpful message if the API isn't reachable.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ask ${escapeHtml(sourceName)}</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{margin-bottom:.25rem}form{display:flex;gap:.5rem;margin:1rem 0}
input{flex:1;padding:.5rem;font-size:1em;border:1px solid #ccc;border-radius:4px}
button{padding:.5rem 1rem;background:#0066cc;color:#fff;border:none;border-radius:4px;cursor:pointer}
.result{padding:1rem;margin:.5rem 0;background:#fff;border:1px solid #ddd;border-radius:4px}
.score{float:right;color:#888;font-size:.85em}
.source{color:#666;font-size:.85em;margin-bottom:.5rem}
.error{color:#a00;padding:1rem;background:#fee;border-radius:4px}
</style></head><body>
<p><a href="./index.html">← Back to wiki</a></p>
<h1>Ask ${escapeHtml(sourceName)}</h1>
<p>Type a question — the RAG index over the chapter pages will return the most relevant passages.</p>
<form id="q"><input name="query" placeholder="What is …?" autofocus required>
<button>Ask</button></form>
<div id="results"></div>
<script>
const indexName = ${JSON.stringify(indexName)};
const form = document.getElementById('q');
const results = document.getElementById('results');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = form.query.value.trim();
  if (!q) return;
  results.innerHTML = '<p><em>Searching…</em></p>';
  try {
    const r = await fetch('/api/rag/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: indexName, query: q, k: 5 }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const hits = data.results || data.hits || [];
    if (!hits.length) { results.innerHTML = '<p><em>No matches.</em></p>'; return; }
    results.innerHTML = hits.map(h => \`<div class="result">
      <span class="score">\${(h.score * 100).toFixed(0)}%</span>
      <div class="source"><strong>\${h.source}</strong> — chunk \${h.chunkNo}</div>
      <div>\${(h.content || '').replace(/</g, '&lt;').slice(0, 800)}\${(h.content || '').length > 800 ? '…' : ''}</div>
    </div>\`).join('');
  } catch (err) {
    results.innerHTML = '<div class="error">Error: ' + (err && err.message || err) + '<br>Is the harness running? <code>npm run web</code> on the project that owns the RAG index.</div>';
  }
});
</script>
</body></html>`;
}

// ─── Orchestrator ───────────────────────────────────────────────────

export interface BuildBlueprintOptions {
  /** Project dir whose .harness/rag/ will receive the index. Defaults to outputDir. */
  projectDir?: string;
  /** Embedding backend. Default: auto. */
  backend?: 'ollama' | 'hash';
  /** Ollama host. Default: http://localhost:11434. */
  ollamaHost?: string;
  /** Override chapter count for the fallback path. */
  fallbackChapters?: number;
  /** Skip RAG index build (faster for smoke tests). */
  skipRag?: boolean;
}

export async function buildBlueprint(pdfPath: string, outputDir: string, options: BuildBlueprintOptions = {}): Promise<BlueprintResult> {
  const absPdf = resolve(pdfPath);
  const absOut = resolve(outputDir);
  if (!existsSync(absPdf)) throw new Error(`PDF not found: ${absPdf}`);
  mkdirSync(absOut, { recursive: true });
  const chaptersDir = join(absOut, 'chapters');
  mkdirSync(chaptersDir, { recursive: true });

  const buffer = readFileSync(absPdf);
  const extracted = await extractPdfText(buffer, { maxChars: 1_000_000 }, absPdf);
  const sourceName = basename(absPdf);

  const chapters = detectChapters(extracted.text, { fallbackChunks: options.fallbackChapters });

  // Write per-chapter pages
  const chapterFiles: string[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    const prev = chapters[i - 1];
    const next = chapters[i + 1];
    const file = join(chaptersDir, `${c.slug}.html`);
    writeFileSync(file, chapterToHtml(c, sourceName, prev, next), 'utf-8');
    chapterFiles.push(file);
  }

  // Write index
  const indexFile = join(absOut, 'index.html');
  writeFileSync(indexFile, indexToHtml(chapters, sourceName, extracted.pageCount), 'utf-8');

  // Build RAG index over the chapter HTML files. We index the HTML (the
  // RAG index strips tags as part of normal text indexing).
  const indexName = slugify(sourceName).replace(/\.pdf$/, '') || 'wiki';
  const projectDir = options.projectDir ?? absOut;
  let ragIndexPath = '';
  if (!options.skipRag) {
    const ollamaHost = options.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    await ragIndex.build(projectDir, indexName, [chaptersDir], {
      backend: options.backend,
      ollamaHost,
    });
    ragIndexPath = join(projectDir, '.harness', 'rag', `${indexName}.json`);
  }

  // Write chat page (always — chat surfaces a clear error if the index is missing)
  const chatFile = join(absOut, 'chat.html');
  writeFileSync(chatFile, chatToHtml(sourceName, indexName), 'utf-8');

  return {
    outputDir: absOut,
    chapters,
    ragIndexName: indexName,
    files: {
      index: indexFile,
      chat: chatFile,
      chapters: chapterFiles,
      ragIndex: ragIndexPath,
    },
  };
}
