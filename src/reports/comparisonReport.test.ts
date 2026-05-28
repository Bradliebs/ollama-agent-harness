/**
 * Tests for the comparison report renderer.
 *
 * These assert structural and behavioural properties — not pixel
 * snapshots — so visual tweaks don't churn the test. To preview the
 * actual rendered HTML, run:
 *   node scripts/preview-comparison-report.js
 */
import { loadPreset } from '../services/comparisonSchema';
import { renderComparisonReport, type ComparisonDataset } from './comparisonReport';

function fixtureDataset(): ComparisonDataset {
  return {
    title: 'Portable aircons under $500',
    goal: 'Find me the best value portable aircons under $500',
    generatedAt: '2026-05-28T14:30:00Z',
    rows: [
      { model: 'CoolBlast 9000', price_usd: 329, btu: 9000, noise_db: 52, energy_class: 'A', weight_kg: 25, url: 'https://example.com/coolblast-9000' },
      { model: 'BreezeMax Pro', price_usd: 449, btu: 12000, noise_db: 49, energy_class: 'A+', weight_kg: 31, url: 'https://example.com/breezemax-pro' },
      { model: 'ChillTech Mini', price_usd: 249, btu: 7000, noise_db: 58, energy_class: 'B', weight_kg: 22, url: 'https://example.com/chilltech-mini' },
      { model: 'FrostWave Elite', price_usd: 479, btu: 10000, noise_db: 46, energy_class: 'A++', weight_kg: 28, url: 'https://example.com/frostwave-elite' },
      // Row with missing data — must render as '?'
      { model: 'MysteryCool X', price_usd: 399, btu: null, noise_db: null, energy_class: null, weight_kg: 27, url: 'https://example.com/mysterycool-x' },
    ],
    sourcePages: [
      { url: 'https://example.com/aircons-roundup', title: 'Best portable aircons 2026', fetchedAt: '2026-05-28T14:25:00Z' },
      { url: 'https://example.com/coolblast-9000', title: 'CoolBlast 9000 product page', fetchedAt: '2026-05-28T14:26:00Z' },
    ],
  };
}

describe('renderComparisonReport', () => {
  it('renders a complete HTML document', async () => {
    const schema = (await loadPreset('aircons'))!;
    const html = renderComparisonReport(fixtureDataset(), schema);

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toMatch(/<\/html>\s*$/);
    expect(html).toContain('<title>Portable aircons under $500</title>');
    expect(html).toContain('<meta charset="utf-8">');
    // Inline CSS + JS, no external assets.
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('renders one table row per dataset row plus a header row', async () => {
    const schema = (await loadPreset('aircons'))!;
    const html = renderComparisonReport(fixtureDataset(), schema);
    const bodyRows = html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1].match(/<tr>/g) ?? [];
    expect(bodyRows.length).toBe(5);
  });

  it("renders null cells as '?' so unverified data is obvious", async () => {
    const schema = (await loadPreset('aircons'))!;
    const html = renderComparisonReport(fixtureDataset(), schema);
    // Scope to <tbody> because the model name also appears in the SVG
    // chart bar labels above the table.
    const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
    const mysteryRow = tbody.match(/<tr>(?:(?!<\/tr>)[\s\S])*?MysteryCool X[\s\S]*?<\/tr>/);
    expect(mysteryRow).not.toBeNull();
    const questionMarks = (mysteryRow![0].match(/<span class="muted">\?<\/span>/g) ?? []).length;
    expect(questionMarks).toBeGreaterThanOrEqual(3);
  });

  it('marks the best-in-column cell with a `best` class', async () => {
    const schema = (await loadPreset('aircons'))!;
    const html = renderComparisonReport(fixtureDataset(), schema);
    // Lowest price is ChillTech Mini at $249. Its price cell should have class `best`.
    expect(html).toMatch(/<td class="num best"[^>]*>\$249<\/td>/);
    // Quietest is FrostWave Elite at 46 dB.
    expect(html).toMatch(/<td class="num best"[^>]*>46 dB<\/td>/);
  });

  it('escapes hostile values and defangs non-http URLs', async () => {
    const schema = (await loadPreset('aircons'))!;
    const dataset = fixtureDataset();
    dataset.rows.push({
      model: '<script>alert(1)</script>',
      price_usd: 99,
      btu: 5000,
      noise_db: 60,
      energy_class: 'C',
      weight_kg: 18,
      url: 'javascript:alert(2)',
    });
    const html = renderComparisonReport(dataset, schema);
    // The raw tag must NOT appear; the escaped form MUST.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Non-http(s) URLs must not become clickable links.
    expect(html).not.toMatch(/<a [^>]*href="javascript:/);
  });

  it('computes a 0..100 score for fully-populated rows and null score when all weighted cells are missing', async () => {
    const schema = (await loadPreset('aircons'))!;
    const dataset: ComparisonDataset = {
      generatedAt: '2026-05-28T00:00:00Z',
      rows: [
        { model: 'Full', price_usd: 100, btu: 10000, noise_db: 40, energy_class: 'A+++', weight_kg: 20, url: 'https://example.com/full' },
        { model: 'Empty', price_usd: null, btu: null, noise_db: null, energy_class: null, weight_kg: null, url: 'https://example.com/empty' },
      ],
      sourcePages: [],
    };
    const html = renderComparisonReport(dataset, schema);
    // 'Empty' row's score cell should render as the muted '?'.
    const emptyRow = html.match(/Empty[\s\S]*?<\/tr>/)![0];
    expect(emptyRow).toMatch(/<td class="num score"[^>]*data-v=""[^>]*>[\s\S]*muted[\s\S]*\?[\s\S]*<\/td>/);
  });

  it('includes the source page links in the footer', async () => {
    const schema = (await loadPreset('aircons'))!;
    const html = renderComparisonReport(fixtureDataset(), schema);
    expect(html).toContain('href="https://example.com/aircons-roundup"');
    expect(html).toContain('Best portable aircons 2026');
    expect(html).toContain('Sources');
  });

  it('renders the chart only when at least one row has a score', async () => {
    const schema = (await loadPreset('aircons'))!;
    const empty: ComparisonDataset = {
      generatedAt: '2026-05-28T00:00:00Z',
      rows: [{ model: 'NoData', price_usd: null, btu: null, noise_db: null, energy_class: null, weight_kg: null, url: '' }],
      sourcePages: [],
    };
    expect(renderComparisonReport(empty, schema)).not.toContain('<svg');
    expect(renderComparisonReport(fixtureDataset(), schema)).toContain('<svg');
  });
});
