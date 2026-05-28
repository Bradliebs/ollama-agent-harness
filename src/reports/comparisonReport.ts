/**
 * comparisonReport — renders a comparison dataset as a self-contained
 * HTML page (no CDN deps, no external CSS/JS, no images).
 *
 * Output is a single string. Callers write it next to the dataset JSON
 * in `agent-outputs/<task-id>.html`. The page has:
 *   - title + meta strip
 *   - summary stats (best value / lowest price / etc., picked dynamically
 *     from scored columns)
 *   - inline SVG bar chart of value-score per row
 *   - sortable table (click any column header)
 *   - sources list
 *   - dark / light auto via prefers-color-scheme
 *
 * Cell values of `null` render as a muted `?` to make unverified data
 * obvious. Best-in-column cells are highlighted.
 *
 * Slice 4.6.0 ships the renderer only — no runner yet.
 */

import type { ComparisonColumn, ComparisonSchema } from '../services/comparisonSchema';

export type RowValue = string | number | null;
export type DatasetRow = Record<string, RowValue>;

export interface SourcePage {
  url: string;
  title: string;
  fetchedAt: string; // ISO timestamp
}

export interface ComparisonDataset {
  /** Human-readable report title. Falls back to the schema title. */
  title?: string;
  /** ISO timestamp of when the dataset was finalised. */
  generatedAt: string;
  /** Original user goal text (shown in the meta strip). */
  goal?: string;
  /** Rows. Missing or unverified values must be `null`. */
  rows: DatasetRow[];
  /** Pages the agent fetched, in order of citation. */
  sourcePages: SourcePage[];
}

interface ScoredRow {
  row: DatasetRow;
  /** 0..100; higher is better. `null` when no scored columns had values for this row. */
  score: number | null;
}

/**
 * Render a dataset + schema as a complete HTML document string.
 */
export function renderComparisonReport(dataset: ComparisonDataset, schema: ComparisonSchema): string {
  const title = dataset.title ?? schema.title;
  const scored = scoreRows(dataset.rows, schema);
  const bestByColumn = computeBestByColumn(dataset.rows, schema);
  const summary = buildSummary(scored, schema);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${esc(title)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    renderHeader(title, dataset, scored.length),
    renderSummary(summary),
    renderChart(scored, schema),
    renderTable(scored, schema, bestByColumn),
    renderSources(dataset.sourcePages),
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* ──────────── scoring ──────────── */

function scoreRows(rows: DatasetRow[], schema: ComparisonSchema): ScoredRow[] {
  const scoredCols = schema.columns.filter((c) => c.weight && c.weight > 0 && c.direction);
  if (scoredCols.length === 0) return rows.map((row) => ({ row, score: null }));

  const ranges = new Map<string, { min: number; max: number }>();
  for (const col of scoredCols) {
    if (col.type === 'number') {
      const values = rows.map((r) => r[col.key]).filter((v): v is number => typeof v === 'number');
      if (values.length === 0) continue;
      ranges.set(col.key, { min: Math.min(...values), max: Math.max(...values) });
    }
  }

  return rows.map((row) => {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const col of scoredCols) {
      const value = row[col.key];
      if (value === null || value === undefined) continue;
      const norm = normaliseValue(value, col, ranges.get(col.key));
      if (norm === null) continue;
      weightedSum += norm * (col.weight ?? 0);
      totalWeight += col.weight ?? 0;
    }
    if (totalWeight === 0) return { row, score: null };
    return { row, score: weightedSum / totalWeight };
  });
}

function normaliseValue(value: RowValue, col: ComparisonColumn, range?: { min: number; max: number }): number | null {
  if (col.type === 'number' && typeof value === 'number' && range) {
    if (range.max === range.min) return 100;
    const ratio = (value - range.min) / (range.max - range.min);
    return col.direction === 'lower-better' ? 100 * (1 - ratio) : 100 * ratio;
  }
  if (col.type === 'enum' && typeof value === 'string' && col.enumValues) {
    const idx = col.enumValues.indexOf(value);
    if (idx < 0) return null;
    if (col.enumValues.length === 1) return 100;
    return 100 * (1 - idx / (col.enumValues.length - 1));
  }
  return null;
}

function computeBestByColumn(rows: DatasetRow[], schema: ComparisonSchema): Map<string, unknown> {
  const best = new Map<string, unknown>();
  for (const col of schema.columns) {
    if (!col.direction) continue;
    let bestVal: RowValue = null;
    for (const row of rows) {
      const v = row[col.key];
      if (v === null || v === undefined) continue;
      if (bestVal === null) { bestVal = v; continue; }
      if (col.type === 'number' && typeof v === 'number' && typeof bestVal === 'number') {
        if (col.direction === 'lower-better' ? v < bestVal : v > bestVal) bestVal = v;
      } else if (col.type === 'enum' && col.enumValues && typeof v === 'string' && typeof bestVal === 'string') {
        const idx = col.enumValues.indexOf(v);
        const bestIdx = col.enumValues.indexOf(bestVal);
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) bestVal = v;
      }
    }
    if (bestVal !== null) best.set(col.key, bestVal);
  }
  return best;
}

/* ──────────── summary stats ──────────── */

interface SummaryStat {
  label: string;
  value: string;
}

function buildSummary(scored: ScoredRow[], schema: ComparisonSchema): SummaryStat[] {
  const stats: SummaryStat[] = [];
  const identifier = schema.columns.find((c) => c.type === 'string');

  const labelFor = (row: DatasetRow): string => {
    if (identifier) {
      const v = row[identifier.key];
      if (typeof v === 'string' && v) return v;
    }
    return '(unknown)';
  };

  const bestScored = scored.filter((s) => s.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (bestScored && bestScored.score !== null) {
    stats.push({ label: 'Best value', value: `${labelFor(bestScored.row)} (${bestScored.score.toFixed(0)}/100)` });
  }

  for (const col of schema.columns) {
    if (!col.direction || col.type === 'string' || stats.length >= 4) continue;
    const sorted = scored
      .map((s) => ({ row: s.row, value: s.row[col.key] }))
      .filter((x) => x.value !== null && x.value !== undefined);
    if (sorted.length === 0) continue;
    if (col.type === 'number') {
      sorted.sort((a, b) => (a.value as number) - (b.value as number));
      const pick = col.direction === 'lower-better' ? sorted[0] : sorted[sorted.length - 1];
      stats.push({
        label: col.direction === 'lower-better' ? `Lowest ${col.label.toLowerCase()}` : `Highest ${col.label.toLowerCase()}`,
        value: `${labelFor(pick.row)} (${formatCell(pick.value, col)})`,
      });
    } else if (col.type === 'enum' && col.enumValues) {
      sorted.sort((a, b) => col.enumValues!.indexOf(a.value as string) - col.enumValues!.indexOf(b.value as string));
      const pick = sorted[0];
      stats.push({ label: `Best ${col.label.toLowerCase()}`, value: `${labelFor(pick.row)} (${formatCell(pick.value, col)})` });
    }
  }
  return stats;
}

/* ──────────── HTML fragments ──────────── */

function renderHeader(title: string, dataset: ComparisonDataset, modelCount: number): string {
  const generated = formatTimestamp(dataset.generatedAt);
  const goalLine = dataset.goal ? `<p class="goal">${esc(dataset.goal)}</p>` : '';
  return [
    '<header>',
    `<h1>${esc(title)}</h1>`,
    goalLine,
    `<p class="meta">${esc(generated)} · ${modelCount} model${modelCount === 1 ? '' : 's'} · ${dataset.sourcePages.length} source${dataset.sourcePages.length === 1 ? '' : 's'}</p>`,
    '</header>',
  ].join('');
}

function renderSummary(stats: SummaryStat[]): string {
  if (stats.length === 0) return '';
  return [
    '<section class="summary">',
    ...stats.map((s) => `<div class="stat"><span class="label">${esc(s.label)}</span><span class="val">${esc(s.value)}</span></div>`),
    '</section>',
  ].join('');
}

function renderChart(scored: ScoredRow[], schema: ComparisonSchema): string {
  const withScore = scored.filter((s) => s.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (withScore.length === 0) return '';
  const identifier = schema.columns.find((c) => c.type === 'string');
  const rowH = 28;
  const padY = 8;
  const labelW = 180;
  const barW = 520;
  const totalH = withScore.length * rowH + padY * 2;
  const totalW = labelW + barW + 60;

  const bars = withScore
    .map((s, i) => {
      const label = identifier ? String(s.row[identifier.key] ?? '?') : `Row ${i + 1}`;
      const score = s.score ?? 0;
      const w = (barW * score) / 100;
      const y = padY + i * rowH;
      return [
        `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" class="bar-label">${esc(truncate(label, 28))}</text>`,
        `<rect x="${labelW}" y="${y + 4}" width="${barW}" height="${rowH - 12}" rx="3" class="bar-track"/>`,
        `<rect x="${labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 12}" rx="3" class="bar-fill"/>`,
        `<text x="${labelW + w + 6}" y="${y + rowH / 2 + 4}" class="bar-value">${score.toFixed(0)}</text>`,
      ].join('');
    })
    .join('');

  return [
    '<section class="chart">',
    '<h2>Value score</h2>',
    `<svg viewBox="0 0 ${totalW} ${totalH}" width="100%" height="${totalH}" role="img" aria-label="Value score by model">`,
    bars,
    '</svg>',
    '<p class="chart-note">0–100. Weighted from price, cooling, noise, energy class, and weight.</p>',
    '</section>',
  ].join('');
}

function renderTable(scored: ScoredRow[], schema: ComparisonSchema, best: Map<string, unknown>): string {
  const cols = schema.columns;
  const head = cols.map((c) => {
    const sortType = c.type === 'number' ? 'number' : c.type === 'enum' ? 'enum' : 'string';
    return `<th data-sort="${sortType}" data-col="${esc(c.key)}">${esc(c.label)}${c.unit ? ` <span class="unit">${esc(c.unit === '$' ? '(USD)' : c.unit)}</span>` : ''}</th>`;
  });
  head.push('<th data-sort="number" data-col="__score">Score</th>');

  const body = scored.map((s) => {
    const cells = cols.map((c) => {
      const v = s.row[c.key];
      const sortVal = v === null || v === undefined ? '' : c.type === 'enum' && c.enumValues
        ? String(c.enumValues.indexOf(String(v)))
        : String(v);
      const klass = [
        c.type === 'number' ? 'num' : c.type === 'enum' ? 'enum' : c.type === 'url' ? 'url' : 'str',
        best.has(c.key) && v !== null && v !== undefined && best.get(c.key) === v ? 'best' : '',
      ].filter(Boolean).join(' ');
      return `<td class="${klass}" data-v="${esc(sortVal)}">${formatCell(v, c)}</td>`;
    });
    const score = s.score === null ? '<span class="muted">?</span>' : `<strong>${s.score.toFixed(0)}</strong>`;
    const scoreSort = s.score === null ? '' : s.score.toFixed(2);
    cells.push(`<td class="num score" data-v="${scoreSort}">${score}</td>`);
    return `<tr>${cells.join('')}</tr>`;
  });

  return [
    '<section class="table-wrap">',
    '<table>',
    `<thead><tr>${head.join('')}</tr></thead>`,
    `<tbody>${body.join('')}</tbody>`,
    '</table>',
    '<p class="table-note">Click any column header to sort. <span class="muted">?</span> = value not verified against source.</p>',
    '</section>',
  ].join('');
}

function renderSources(sources: SourcePage[]): string {
  if (sources.length === 0) return '<footer><p class="disclaimer">No source pages recorded.</p></footer>';
  const items = sources
    .map((s) => `<li><a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.title || s.url)}</a> <span class="muted">· fetched ${esc(formatTimestamp(s.fetchedAt))}</span></li>`)
    .join('');
  return [
    '<footer>',
    '<h3>Sources</h3>',
    `<ul>${items}</ul>`,
    '<p class="disclaimer">Generated by the Ollama Agent Harness. Cells marked <span class="muted">?</span> could not be verified against the source page — treat with caution.</p>',
    '</footer>',
  ].join('');
}

/* ──────────── value formatting ──────────── */

function formatCell(value: RowValue, col: ComparisonColumn): string {
  if (value === null || value === undefined) return '<span class="muted">?</span>';
  if (col.type === 'url' && typeof value === 'string') {
    // Only render http(s) links; defang anything else (javascript:, data:,
    // file:) because the report is opened directly from disk and a
    // malicious source page could otherwise inject an active link.
    if (/^https?:\/\//i.test(value)) {
      return `<a href="${esc(value)}" rel="noopener noreferrer">link ↗</a>`;
    }
    return `<span class="muted" title="non-http URL was hidden">${esc(value)}</span>`;
  }
  if (col.type === 'number' && typeof value === 'number') {
    const formatted = formatNumber(value);
    if (col.unit === '$') return `$${formatted}`;
    if (col.unit) return `${formatted} ${esc(col.unit)}`;
    return formatted;
  }
  return esc(String(value));
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ──────────── inline CSS ────────────
 * Single-block, hand-written. Light + dark via prefers-color-scheme.
 * No external fonts, no images. Designed for one-screen comprehension.
 */
const STYLES = `
*{box-sizing:border-box}
html{color-scheme:light dark}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;
  margin:0;padding:0;line-height:1.45;
  background:#fff;color:#1a1a1a;
}
@media (prefers-color-scheme: dark){
  body{background:#0f1115;color:#e5e7eb}
}
header,section,footer{max-width:1100px;margin:0 auto;padding:20px 28px}
header{padding-top:36px;padding-bottom:18px;border-bottom:1px solid rgba(127,127,127,.18)}
h1{margin:0 0 4px;font-size:26px;letter-spacing:-.01em}
.goal{margin:8px 0 4px;font-style:italic;color:#555}
.meta{margin:6px 0 0;font-size:13px;color:#6b7280}
@media (prefers-color-scheme: dark){.goal{color:#9ca3af}.meta{color:#9ca3af}}
.summary{display:flex;flex-wrap:wrap;gap:12px;padding-top:18px;padding-bottom:8px}
.stat{
  flex:1 1 200px;
  background:rgba(127,127,127,.07);
  border:1px solid rgba(127,127,127,.12);
  border-radius:8px;
  padding:12px 14px;
  display:flex;flex-direction:column;gap:2px;
}
.stat .label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280}
.stat .val{font-size:15px;font-weight:600}
.chart{padding-top:24px}
.chart h2{margin:0 0 12px;font-size:16px;font-weight:600}
.chart svg{display:block}
.bar-track{fill:rgba(127,127,127,.12)}
.bar-fill{fill:#2563eb}
@media (prefers-color-scheme: dark){.bar-fill{fill:#60a5fa}}
.bar-label{font-size:12px;fill:#374151}
.bar-value{font-size:12px;fill:#374151;font-weight:600}
@media (prefers-color-scheme: dark){.bar-label{fill:#cbd5e1}.bar-value{fill:#cbd5e1}}
.chart-note,.table-note,.disclaimer{font-size:12px;color:#6b7280;margin-top:8px}
.table-wrap{padding-top:24px;padding-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{
  text-align:left;padding:10px 12px;
  border-bottom:2px solid rgba(127,127,127,.25);
  font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;
  cursor:pointer;user-select:none;position:sticky;top:0;
  background:#fff;
}
@media (prefers-color-scheme: dark){thead th{background:#0f1115;color:#9ca3af}}
thead th .unit{font-weight:400;text-transform:none;letter-spacing:0;color:#9ca3af;margin-left:3px}
thead th.asc::after{content:' ▲';color:#2563eb}
thead th.desc::after{content:' ▼';color:#2563eb}
@media (prefers-color-scheme: dark){thead th.asc::after,thead th.desc::after{color:#60a5fa}}
tbody td{padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.12);vertical-align:top}
tbody tr:hover{background:rgba(127,127,127,.05)}
td.num,td.score{text-align:right;font-variant-numeric:tabular-nums}
td.url a{color:#2563eb;text-decoration:none}
td.url a:hover{text-decoration:underline}
@media (prefers-color-scheme: dark){td.url a{color:#60a5fa}}
td.best{background:rgba(34,197,94,.10);font-weight:600}
@media (prefers-color-scheme: dark){td.best{background:rgba(34,197,94,.16)}}
.muted{color:#9ca3af}
footer{padding-top:28px;padding-bottom:48px;border-top:1px solid rgba(127,127,127,.18);margin-top:24px}
footer h3{margin:0 0 10px;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6b7280}
footer ul{margin:0;padding-left:18px}
footer li{margin-bottom:6px;font-size:13px}
footer a{color:#2563eb;text-decoration:none}
footer a:hover{text-decoration:underline}
@media (prefers-color-scheme: dark){footer a{color:#60a5fa}}
`.trim();

/* ──────────── inline JS for sortable table ──────────── */
const SCRIPT = `
document.querySelectorAll('thead th[data-sort]').forEach(function(th){
  th.addEventListener('click', function(){
    var table = th.closest('table');
    var tbody = table.querySelector('tbody');
    var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
    var type = th.dataset.sort;
    var asc = !th.classList.contains('asc');
    Array.prototype.forEach.call(th.parentNode.children, function(t){ t.classList.remove('asc','desc'); });
    th.classList.add(asc ? 'asc' : 'desc');
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    rows.sort(function(a,b){
      var av = a.children[idx].getAttribute('data-v') || '';
      var bv = b.children[idx].getAttribute('data-v') || '';
      if (av === '' && bv === '') return 0;
      if (av === '') return 1;
      if (bv === '') return -1;
      var cmp;
      if (type === 'number' || type === 'enum') cmp = parseFloat(av) - parseFloat(bv);
      else cmp = av.localeCompare(bv);
      return cmp * (asc ? 1 : -1);
    });
    rows.forEach(function(r){ tbody.appendChild(r); });
  });
});
`.trim();
