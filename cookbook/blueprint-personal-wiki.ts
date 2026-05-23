/**
 * blueprint-personal-wiki.ts — CopilotForge Cookbook Recipe
 *
 * Renders a browsable static "memory wiki" from a list of entries
 * pulled from the harness's semantic memory store (or any other source
 * that adopts the EntryLike shape).
 *
 * Pure renderer — the caller is responsible for fetching entries via
 * `searchSemanticMemory` / `rebuildSemanticMemory` / session storage,
 * then handing the list in. That keeps the recipe testable offline and
 * lets it be used by either a scheduled job or an on-demand /goal task.
 *
 * Output:
 *   <outDir>/index.html                — landing page with search + day index
 *   <outDir>/entries/<id>.html         — one page per entry
 *   <outDir>/by-day/<YYYY-MM-DD>.html  — daily roll-up pages
 *
 * Usage (standalone, with a JSON input file):
 *   ts-node cookbook/blueprint-personal-wiki.ts <entries.json> <output-dir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface MemoryEntryLike {
  /** Stable id, used for filenames and inter-page links. */
  id: string;
  /** ISO timestamp. The blueprint groups entries by the date prefix. */
  timestamp: string;
  /** Short label for the entry kind ("session", "decision", "note"…). */
  kind: string;
  /** Full body text. May span paragraphs. */
  text: string;
  /** Optional source/session id for back-linking. */
  sessionId?: string;
  /** Optional list of tags for faceting. */
  tags?: string[];
}

export interface BuildWikiResult {
  outputDir: string;
  indexFile: string;
  entryFiles: string[];
  dayFiles: string[];
  totalEntries: number;
  days: string[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeFilename(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return cleaned || 'entry';
}

function dayKey(timestamp: string): string {
  // Accept ISO timestamps; fall back to 'unknown' for unparseable values.
  const m = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : 'unknown';
}

function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

const COMMON_STYLE = `
body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
header{border-bottom:1px solid #ddd;padding-bottom:1rem;margin-bottom:1.5rem;display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap}
header h1{margin:0}.meta{color:#666;font-size:.9em}
nav.crumbs{font-size:.9em;margin-bottom:1rem}nav.crumbs a{color:#0066cc;text-decoration:none}nav.crumbs a:hover{text-decoration:underline}
ul.entries{list-style:none;padding:0}ul.entries li{padding:.75rem 0;border-bottom:1px solid #eee}
ul.entries .kind{display:inline-block;font-size:.75em;padding:.1em .5em;background:#e0e0e0;border-radius:3px;margin-right:.5em;vertical-align:middle}
ul.entries .ts{color:#888;font-size:.85em;margin-right:.5em}
ul.entries .tags{color:#666;font-size:.8em;margin-left:.5em}
a{color:#0066cc}
input[type=search]{width:100%;padding:.5rem;font-size:1em;border:1px solid #ccc;border-radius:4px;margin-bottom:1rem}
.empty{color:#888;font-style:italic;padding:1rem 0}
`;

function renderIndex(entries: MemoryEntryLike[], dayCounts: Map<string, number>, title: string): string {
  const recentEntries = entries.slice(0, 50);
  const entryLis = recentEntries.length
    ? recentEntries.map((e) => `<li data-search="${escapeHtml((e.kind + ' ' + (e.tags ?? []).join(' ') + ' ' + e.text).toLowerCase())}">
        <span class="kind">${escapeHtml(e.kind)}</span>
        <span class="ts">${escapeHtml(dayKey(e.timestamp))}</span>
        <a href="./entries/${safeFilename(e.id)}.html">${escapeHtml(e.text.slice(0, 120))}${e.text.length > 120 ? '…' : ''}</a>
        ${(e.tags ?? []).length ? '<span class="tags">' + (e.tags ?? []).map((t) => '#' + escapeHtml(t)).join(' ') + '</span>' : ''}
      </li>`).join('\n')
    : '<li class="empty">No entries yet.</li>';

  const days = Array.from(dayCounts.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const dayLis = days.length
    ? days.map(([d, count]) => `<li><a href="./by-day/${d}.html">${escapeHtml(d)}</a> <span class="ts">(${count})</span></li>`).join('\n')
    : '<li class="empty">No days indexed.</li>';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${COMMON_STYLE}</style></head><body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${days.length} day${days.length === 1 ? '' : 's'}</div>
</header>
<input type="search" id="q" placeholder="Filter entries…" oninput="window.__filter && window.__filter(this.value)">
<h2>Recent (${recentEntries.length} of ${entries.length})</h2>
<ul class="entries" id="entries">${entryLis}</ul>
<h2>By day</h2>
<ul class="entries">${dayLis}</ul>
<script>
window.__filter = function(q) {
  q = (q || '').toLowerCase().trim();
  for (const li of document.querySelectorAll('#entries li')) {
    const hay = li.getAttribute('data-search') || '';
    li.style.display = (!q || hay.includes(q)) ? '' : 'none';
  }
};
</script>
</body></html>`;
}

function renderEntry(entry: MemoryEntryLike): string {
  const tags = (entry.tags ?? []).map((t) => '<span class="tags">#' + escapeHtml(t) + '</span>').join(' ');
  const session = entry.sessionId
    ? `<div class="meta">Session: <code>${escapeHtml(entry.sessionId)}</code></div>`
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(entry.kind)} — ${escapeHtml(dayKey(entry.timestamp))}</title>
<style>${COMMON_STYLE}</style></head><body>
<nav class="crumbs"><a href="../index.html">← Index</a> · <a href="../by-day/${dayKey(entry.timestamp)}.html">${escapeHtml(dayKey(entry.timestamp))}</a></nav>
<header>
  <h1><span class="kind">${escapeHtml(entry.kind)}</span> ${tags}</h1>
  <div class="meta">${escapeHtml(entry.timestamp)}</div>
</header>
${session}
${paragraphs(entry.text)}
</body></html>`;
}

function renderDay(day: string, entries: MemoryEntryLike[]): string {
  const lis = entries.length
    ? entries.map((e) => `<li>
        <span class="kind">${escapeHtml(e.kind)}</span>
        <a href="../entries/${safeFilename(e.id)}.html">${escapeHtml(e.text.slice(0, 160))}${e.text.length > 160 ? '…' : ''}</a>
      </li>`).join('\n')
    : '<li class="empty">No entries on this day.</li>';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(day)}</title>
<style>${COMMON_STYLE}</style></head><body>
<nav class="crumbs"><a href="../index.html">← Index</a></nav>
<header>
  <h1>${escapeHtml(day)}</h1>
  <div class="meta">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</div>
</header>
<ul class="entries">${lis}</ul>
</body></html>`;
}

export interface BuildWikiOptions {
  /** Wiki title shown on the index page. Default: "Personal Memory Wiki". */
  title?: string;
}

export function buildPersonalWiki(
  entries: MemoryEntryLike[],
  outputDir: string,
  options: BuildWikiOptions = {},
): BuildWikiResult {
  const absOut = resolve(outputDir);
  mkdirSync(absOut, { recursive: true });
  mkdirSync(join(absOut, 'entries'), { recursive: true });
  mkdirSync(join(absOut, 'by-day'), { recursive: true });

  // Sort entries newest-first for the index.
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Group by day for day pages.
  const byDay = new Map<string, MemoryEntryLike[]>();
  for (const e of sorted) {
    const d = dayKey(e.timestamp);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(e);
  }
  const dayCounts = new Map<string, number>();
  for (const [d, list] of byDay) dayCounts.set(d, list.length);

  const entryFiles: string[] = [];
  for (const e of sorted) {
    const file = join(absOut, 'entries', `${safeFilename(e.id)}.html`);
    writeFileSync(file, renderEntry(e), 'utf-8');
    entryFiles.push(file);
  }

  const dayFiles: string[] = [];
  for (const [day, list] of byDay) {
    const file = join(absOut, 'by-day', `${day}.html`);
    writeFileSync(file, renderDay(day, list), 'utf-8');
    dayFiles.push(file);
  }

  const indexFile = join(absOut, 'index.html');
  writeFileSync(indexFile, renderIndex(sorted, dayCounts, options.title ?? 'Personal Memory Wiki'), 'utf-8');

  return {
    outputDir: absOut,
    indexFile,
    entryFiles,
    dayFiles,
    totalEntries: sorted.length,
    days: Array.from(byDay.keys()),
  };
}

if (require.main === module) {
  const [, , entriesPath, outDir] = process.argv;
  if (!entriesPath || !outDir) {
    process.stderr.write('Usage: ts-node cookbook/blueprint-personal-wiki.ts <entries.json> <output-dir>\n');
    process.exit(1);
  }
  try {
    const entries = JSON.parse(readFileSync(resolve(entriesPath), 'utf-8')) as MemoryEntryLike[];
    const result = buildPersonalWiki(entries, outDir);
    process.stdout.write(`[wiki] ✅ Built at ${result.outputDir}\n`);
    process.stdout.write(`[wiki]    ${result.totalEntries} entries across ${result.days.length} day(s)\n`);
    process.stdout.write(`[wiki]    Index: ${result.indexFile}\n`);
  } catch (err) {
    process.stderr.write(`[wiki] ❌ ${err && (err as Error).stack || err}\n`);
    process.exit(2);
  }
  // Silence unused-import lint for dirname (imported for clarity when extending).
  void dirname;
}
