/**
 * blueprint-competitor-research.ts — CopilotForge Cookbook Recipe
 *
 * Renders a polished, self-contained HTML research report from a
 * structured `ResearchInput`. Pure composition — the gathering step
 * (web search, page reads, model analysis) is the caller's job. This
 * separation keeps the renderer testable offline and lets the autonomy
 * loop (`/goal research …` + agent tool calls) supply real data.
 *
 * Typical wiring:
 *   1. The autonomy loop's "gather" task uses `web_search` + `web_read`
 *      to assemble a ResearchInput object.
 *   2. The "report" task imports buildResearchReport and writes the
 *      HTML to .harness/research/<subject>.html.
 *
 * Usage (standalone, with a JSON input file):
 *   ts-node cookbook/blueprint-competitor-research.ts <input.json> <output.html>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ResearchSource {
  title: string;
  url?: string;
  /** Short snippet or finding from this source. */
  snippet?: string;
  /** Optional ISO timestamp of when the source was retrieved. */
  retrievedAt?: string;
}

export interface ResearchFinding {
  /** Short label, e.g. "Tech stack" or "Pricing". */
  label: string;
  /** Full prose finding. May contain newlines; rendered as paragraphs. */
  body: string;
  /** Optional confidence score in [0, 1]. */
  confidence?: number;
  /** Indices into the sources array that back this finding. */
  sourceIds?: number[];
}

export interface ResearchInput {
  /** What was researched (company, product, domain, question). */
  subject: string;
  /** One-paragraph executive summary. */
  summary: string;
  /** Optional pre-filled "answer" if the research had a primary question. */
  oneLineAnswer?: string;
  /** Structured findings, each with sources. */
  findings: ResearchFinding[];
  /** Sources cited across the findings. */
  sources: ResearchSource[];
  /** Optional ISO timestamp; defaults to now at render time. */
  generatedAt?: string;
}

export interface RenderedReport {
  html: string;
  /** A short Markdown email-friendly summary. */
  markdownSummary: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function renderSourceLink(s: ResearchSource, index: number): string {
  const linkText = `[${index + 1}] ${escapeHtml(s.title || s.url || 'untitled')}`;
  if (s.url) return `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${linkText}</a>`;
  return linkText;
}

/** Render a ResearchInput into a polished, self-contained HTML report. */
export function buildResearchReport(input: ResearchInput): RenderedReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const subjectEsc = escapeHtml(input.subject);

  const findingsHtml = input.findings.length
    ? input.findings.map((f) => {
        const sourceTags = (f.sourceIds ?? [])
          .filter((i) => i >= 0 && i < input.sources.length)
          .map((i) => `<sup>[${i + 1}]</sup>`)
          .join(' ');
        const conf = typeof f.confidence === 'number'
          ? `<span class="confidence">${Math.round(Math.max(0, Math.min(1, f.confidence)) * 100)}% confidence</span>`
          : '';
        return `<section class="finding">
  <h3>${escapeHtml(f.label)} ${sourceTags} ${conf}</h3>
  ${paragraphs(f.body)}
</section>`;
      }).join('\n')
    : '<p><em>No findings recorded.</em></p>';

  const sourcesHtml = input.sources.length
    ? '<ol class="sources">' + input.sources.map((s, i) => {
        const meta = s.snippet ? `<div class="snippet">${escapeHtml(s.snippet)}</div>` : '';
        const ts = s.retrievedAt ? `<div class="retrieved">retrieved ${escapeHtml(s.retrievedAt)}</div>` : '';
        return `<li>${renderSourceLink(s, i)}${meta}${ts}</li>`;
      }).join('\n') + '</ol>'
    : '<p><em>No sources cited.</em></p>';

  const oneLine = input.oneLineAnswer
    ? `<div class="answer"><strong>Answer:</strong> ${escapeHtml(input.oneLineAnswer)}</div>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Research: ${subjectEsc}</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
header{border-bottom:1px solid #ddd;padding-bottom:1rem;margin-bottom:1.5rem}
header h1{margin:0 0 .25rem}.meta{color:#666;font-size:.9em}
.answer{padding:1rem;background:#fff8e1;border-left:4px solid #f5b800;margin:1rem 0;border-radius:4px}
.summary{padding:1rem;background:#fff;border-radius:4px;border:1px solid #ddd;margin:1rem 0}
section.finding{margin:1.5rem 0;padding:1rem;background:#fff;border-radius:4px;border:1px solid #ddd}
section.finding h3{margin:0 0 .5rem;display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
sup{color:#0066cc;font-size:.75em}
.confidence{font-size:.7em;color:#666;background:#f0f0f0;padding:.1em .5em;border-radius:3px;font-weight:normal}
.sources{padding-left:1.5em}.sources li{margin:.5rem 0}
.snippet{color:#555;font-size:.9em;margin:.25rem 0}
.retrieved{color:#888;font-size:.8em;font-style:italic}
a{color:#0066cc}a:hover{text-decoration:underline}
</style></head><body>
<header>
  <h1>${subjectEsc}</h1>
  <div class="meta">Research report · generated ${escapeHtml(generatedAt)}</div>
</header>
${oneLine}
<div class="summary">${paragraphs(input.summary)}</div>
<h2>Findings</h2>
${findingsHtml}
<h2>Sources</h2>
${sourcesHtml}
</body></html>`;

  const mdLines: string[] = [];
  mdLines.push(`# Research: ${input.subject}`);
  mdLines.push('');
  mdLines.push(`_Generated ${generatedAt}_`);
  mdLines.push('');
  if (input.oneLineAnswer) {
    mdLines.push(`**Answer:** ${input.oneLineAnswer}`);
    mdLines.push('');
  }
  mdLines.push(input.summary);
  mdLines.push('');
  mdLines.push('## Findings');
  for (const f of input.findings) {
    mdLines.push(`- **${f.label}** — ${f.body.split(/\n/)[0]}`);
  }
  mdLines.push('');
  mdLines.push('## Sources');
  input.sources.forEach((s, i) => {
    mdLines.push(`${i + 1}. ${s.title}${s.url ? ` (${s.url})` : ''}`);
  });
  const markdownSummary = mdLines.join('\n');

  return { html, markdownSummary };
}

/** Convenience: render and write the HTML to disk. */
export function writeResearchReport(input: ResearchInput, outputPath: string): RenderedReport {
  const abs = resolve(outputPath);
  mkdirSync(dirname(abs), { recursive: true });
  const rendered = buildResearchReport(input);
  writeFileSync(abs, rendered.html, 'utf-8');
  return rendered;
}

if (require.main === module) {
  const [, , inputPath, outPath] = process.argv;
  if (!inputPath || !outPath) {
    process.stderr.write('Usage: ts-node cookbook/blueprint-competitor-research.ts <input.json> <output.html>\n');
    process.exit(1);
  }
  try {
    const input = JSON.parse(readFileSync(resolve(inputPath), 'utf-8')) as ResearchInput;
    const result = writeResearchReport(input, outPath);
    process.stdout.write(`[research] ✅ Wrote ${outPath} (${result.html.length} bytes)\n`);
  } catch (err) {
    process.stderr.write(`[research] ❌ ${err && (err as Error).stack || err}\n`);
    process.exit(2);
  }
}
