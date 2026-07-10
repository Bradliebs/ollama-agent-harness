#!/usr/bin/env node
/**
 * scripts/research-report.js — gather → synthesize → render flow.
 *
 * Uses WebSearchTool to gather snippets for one or more queries, optionally
 * synthesizes them with a local Ollama chat model, then hands the structured
 * ResearchInput to cookbook/blueprint-competitor-research's writeResearchReport.
 *
 * Usage:
 *   node scripts/research-report.js --subject "Acme Corp"
 *   node scripts/research-report.js --subject "Acme" --queries "Acme tech;Acme pricing"
 *   node scripts/research-report.js --subject "Acme" --offline --fixture fixtures/acme.json
 *
 * Env:
 *   HARNESS_MODEL                Ollama model (default: llama3.1:8b)
 *   HARNESS_OLLAMA_HOST          Ollama host (default: http://localhost:11434)
 *   HARNESS_RESEARCH_OFFLINE=1   Hard switch — forces offline mode
 *
 * Exit codes:
 *   0  report written
 *   1  invalid arguments
 *   2  runtime error
 */

'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function parseArgs(argv) {
  const args = {
    subject: '',
    queries: null,
    out: null,
    offline: false,
    fixture: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--subject' || a === '-s') args.subject = argv[++i];
    else if (a === '--queries' || a === '-q') args.queries = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--offline') args.offline = true;
    else if (a === '--fixture' || a === '-f') args.fixture = argv[++i];
    else return { error: `unknown argument: ${a}` };
  }
  if (!args.subject) return { error: 'missing required --subject' };
  return args;
}

function usage() {
  process.stdout.write(
    'Usage: node scripts/research-report.js --subject "<subject>" [options]\n' +
    '\n' +
    'Options:\n' +
    '  --subject, -s "X"      Subject to research (required)\n' +
    '  --queries, -q "a;b;c"  Semicolon-separated search queries (default: [subject])\n' +
    '  --out, -o PATH         Output HTML path (default: .harness/research/<slug>.html)\n' +
    '  --offline              Skip live web search + model; stub findings (or use --fixture)\n' +
    '  --fixture, -f PATH     JSON fixture file with a ResearchInput (implies offline-style flow)\n' +
    '  --help, -h             Show this message\n' +
    '\n' +
    'Env:\n' +
    '  HARNESS_MODEL                Ollama model (default: llama3.1:8b)\n' +
    '  HARNESS_OLLAMA_HOST          Ollama host (default: http://localhost:11434)\n' +
    '  HARNESS_RESEARCH_OFFLINE=1   Hard switch forcing offline mode\n',
  );
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'research';
}

function loadCookbook() {
  let tsNodeRegistered = false;
  try {
    require('ts-node/register/transpile-only');
    tsNodeRegistered = true;
  } catch {
    try {
      require('ts-node/register');
      tsNodeRegistered = true;
    } catch {
      // fall through — cookbook is .ts so this will fail loudly below
    }
  }
  try {
    return require('../cookbook/blueprint-competitor-research');
  } catch (err) {
    if (!tsNodeRegistered) {
      throw new Error('cookbook/blueprint-competitor-research requires ts-node; install dev deps and retry');
    }
    throw err;
  }
}

function loadWebSearchTool() {
  try {
    return require('../src/tools/webSearchTool').WebSearchTool;
  } catch {
    return require('../dist/tools/webSearchTool').WebSearchTool;
  }
}

/**
 * Parse WebSearchTool's human-readable output into source records.
 * Format produced by webSearchTool.ts:
 *   Search results for "<query>":
 *
 *   1. **Title**
 *      https://url
 *      Snippet text
 *
 *   2. ...
 */
function parseSearchOutput(output, query) {
  if (!output || typeof output !== 'string') return [];
  const sources = [];
  const blockRe = /^\s*\d+\.\s+\*\*(.+?)\*\*\s*\n\s+(\S+)\s*\n\s+([\s\S]*?)(?=\n\s*\d+\.\s+\*\*|\s*$)/gm;
  let m;
  while ((m = blockRe.exec(output)) !== null) {
    sources.push({
      title: m[1].trim(),
      url: m[2].trim(),
      snippet: m[3].trim().replace(/\s+/g, ' '),
    });
  }
  if (sources.length === 0) {
    // Couldn't structurally parse — pass through the whole blob as one source.
    sources.push({ title: `Search results for "${query}"`, snippet: output.slice(0, 500) });
  }
  return sources;
}

function buildStubInput(subject, gathered) {
  const allSources = [];
  const findings = [];
  for (const { query, sources } of gathered) {
    const offset = allSources.length;
    allSources.push(...sources);
    if (sources.length === 0) continue;
    findings.push({
      label: query,
      body: sources.map((s, i) => `${i + 1}. ${s.title}${s.snippet ? ` — ${s.snippet}` : ''}`).join('\n'),
      sourceIds: sources.map((_, i) => offset + i),
    });
  }
  return {
    subject,
    summary: `Offline research stub for "${subject}". ${findings.length} query block(s) gathered from web search snippets; no model synthesis was performed.`,
    findings: findings.length > 0
      ? findings
      : [{ label: 'No data', body: 'No search results were gathered.', sourceIds: [] }],
    sources: allSources,
    generatedAt: new Date().toISOString(),
  };
}

async function synthesizeWithOllama(subject, gathered) {
  const host = process.env.HARNESS_OLLAMA_HOST || 'http://localhost:11434';
  const model = process.env.HARNESS_MODEL || 'llama3.1:8b';
  const allSources = [];
  const contextBlocks = [];
  for (const { query, sources } of gathered) {
    const offset = allSources.length;
    allSources.push(...sources);
    contextBlocks.push(
      `### Query: ${query}\n` +
      sources.map((s, i) => `[${offset + i + 1}] ${s.title}${s.url ? ` (${s.url})` : ''}\n    ${s.snippet || ''}`).join('\n'),
    );
  }

  const prompt =
    `You are a concise research analyst. Subject: ${subject}\n\n` +
    `Given these search results, produce a STRICT JSON object with keys:\n` +
    `  summary       (string, 1 short paragraph)\n` +
    `  oneLineAnswer (string, single sentence)\n` +
    `  findings      (array of { label, body, confidence })\n` +
    `Be concise. Output ONLY the JSON object, no prose, no code fences.\n\n` +
    contextBlocks.join('\n\n');

  const response = await fetch(`${host.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama chat failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const content = payload?.message?.content ?? '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    process.stderr.write(`[research] ⚠️  Model returned non-JSON; falling back to stub. (${err && err.message || err})\n`);
    return buildStubInput(subject, gathered);
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings.map((f) => ({
    label: String(f.label ?? 'Finding'),
    body: String(f.body ?? ''),
    confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
  })) : [];
  return {
    subject,
    summary: String(parsed.summary ?? `Research on ${subject}.`),
    oneLineAnswer: parsed.oneLineAnswer ? String(parsed.oneLineAnswer) : undefined,
    findings: findings.length > 0 ? findings : [{ label: 'No findings', body: 'Model returned no findings.' }],
    sources: allSources,
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.error) { process.stderr.write(`[research] ${args.error}\n\n`); usage(); return 1; }

  const offline = args.offline || process.env.HARNESS_RESEARCH_OFFLINE === '1' || !!args.fixture;
  const outPath = resolve(args.out || `.harness/research/${slugify(args.subject)}.html`);

  const { writeResearchReport } = loadCookbook();

  let input;
  if (args.fixture) {
    const fixturePath = resolve(args.fixture);
    if (!existsSync(fixturePath)) {
      process.stderr.write(`[research] fixture not found: ${fixturePath}\n`);
      return 2;
    }
    const parsed = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    input = { ...parsed, subject: parsed.subject || args.subject };
  } else {
    const queries = (args.queries ? args.queries.split(';') : [args.subject])
      .map((q) => q.trim())
      .filter(Boolean);

    const WebSearchTool = loadWebSearchTool();
    const gathered = [];
    for (const query of queries) {
      process.stdout.write(`[research] 🔎 searching: ${query}\n`);
      const result = await WebSearchTool.execute({ query, max_results: 5 });
      if (!result.success) {
        process.stderr.write(`[research] ⚠️  search failed for "${query}": ${result.error || result.output}\n`);
        continue;
      }
      gathered.push({ query, sources: parseSearchOutput(result.output, query) });
    }

    if (offline) {
      input = buildStubInput(args.subject, gathered);
    } else {
      try {
        input = await synthesizeWithOllama(args.subject, gathered);
      } catch (err) {
        process.stderr.write(`[research] ⚠️  Ollama unavailable (${err && err.message || err}); falling back to stub.\n`);
        input = buildStubInput(args.subject, gathered);
      }
    }
  }

  const rendered = writeResearchReport(input, outPath);
  process.stdout.write(`[research] ✅ Wrote ${outPath} (${rendered.html.length} bytes)\n`);
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => { process.stderr.write(`[research] fatal: ${err && err.stack || err}\n`); process.exit(2); },
);
