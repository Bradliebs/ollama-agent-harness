/**
 * Tests for the competitor-research blueprint.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildResearchReport, writeResearchReport, type ResearchInput } from '../../cookbook/blueprint-competitor-research';

const SAMPLE_INPUT: ResearchInput = {
  subject: 'Acme Corp',
  summary: 'Acme is a regional player in widget manufacturing.\n\nThey shipped a new SaaS bundle in Q3.',
  oneLineAnswer: 'Acme is migrating to a SaaS revenue model.',
  findings: [
    {
      label: 'Tech stack',
      body: 'Acme uses Python on the backend and React on the frontend.',
      confidence: 0.8,
      sourceIds: [0, 1],
    },
    {
      label: 'Pricing',
      body: 'Tiered: $49 / $149 / Enterprise.',
      sourceIds: [1],
    },
  ],
  sources: [
    { title: 'Acme careers page', url: 'https://acme.example.com/careers', snippet: 'Looking for Python and React engineers.' },
    { title: 'Acme pricing', url: 'https://acme.example.com/pricing', snippet: 'See our tier comparison.' },
  ],
  generatedAt: '2026-05-23T12:00:00.000Z',
};

describe('buildResearchReport', () => {
  it('renders the subject as the H1 title', () => {
    const { html } = buildResearchReport(SAMPLE_INPUT);
    expect(html).toContain('<h1>Acme Corp</h1>');
    expect(html).toContain('Research: Acme Corp');
  });

  it('renders the one-line answer when provided', () => {
    const { html } = buildResearchReport(SAMPLE_INPUT);
    expect(html).toMatch(/<div class="answer">.*Acme is migrating/s);
  });

  it('omits the answer block when oneLineAnswer is missing', () => {
    const { html } = buildResearchReport({ ...SAMPLE_INPUT, oneLineAnswer: undefined });
    expect(html).not.toContain('class="answer"');
  });

  it('escapes HTML in subject, summary, findings, and sources', () => {
    const { html } = buildResearchReport({
      ...SAMPLE_INPUT,
      subject: 'Acme <script>alert(1)</script>',
      summary: 'Body with <b>html</b>.',
      findings: [{ label: 'Edge <case>', body: 'Body & symbols >', sourceIds: [] }],
      sources: [{ title: 'Quoted "title"', url: 'https://x.example.com?q=1&r=2' }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;html&lt;/b&gt;');
    expect(html).toContain('Edge &lt;case&gt;');
    expect(html).toContain('Quoted &quot;title&quot;');
    expect(html).toContain('q=1&amp;r=2');
  });

  it('renders sources as a numbered list with links', () => {
    const { html } = buildResearchReport(SAMPLE_INPUT);
    expect(html).toContain('<ol class="sources">');
    expect(html).toContain('href="https://acme.example.com/careers"');
    expect(html).toContain('[1]');
    expect(html).toContain('[2]');
  });

  it('renders findings with their source superscripts and confidence badge', () => {
    const { html } = buildResearchReport(SAMPLE_INPUT);
    expect(html).toMatch(/Tech stack.*\[1\].*\[2\].*80% confidence/s);
    expect(html).toMatch(/Pricing.*\[2\]/s);
  });

  it('handles empty findings and sources gracefully', () => {
    const { html } = buildResearchReport({
      subject: 'Empty', summary: 'Nothing.', findings: [], sources: [],
    });
    expect(html).toContain('<h1>Empty</h1>');
    expect(html).toContain('No findings recorded.');
    expect(html).toContain('No sources cited.');
  });

  it('produces an email-friendly Markdown summary', () => {
    const { markdownSummary } = buildResearchReport(SAMPLE_INPUT);
    expect(markdownSummary).toMatch(/^# Research: Acme Corp/);
    expect(markdownSummary).toContain('**Answer:** Acme is migrating');
    expect(markdownSummary).toContain('- **Tech stack**');
    expect(markdownSummary).toContain('1. Acme careers page');
  });
});

describe('writeResearchReport', () => {
  let workDir: string;
  beforeAll(() => { workDir = mkdtempSync(join(tmpdir(), 'research-')); });
  afterAll(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('writes the HTML to disk and creates parent directories', () => {
    const out = join(workDir, 'nested', 'sub', 'acme.html');
    const result = writeResearchReport(SAMPLE_INPUT, out);
    expect(existsSync(out)).toBe(true);
    const fileContent = readFileSync(out, 'utf-8');
    expect(fileContent).toBe(result.html);
    expect(fileContent).toContain('<h1>Acme Corp</h1>');
  });
});
