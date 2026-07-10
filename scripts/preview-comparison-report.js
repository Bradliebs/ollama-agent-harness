#!/usr/bin/env node
/**
 * Preview the comparison report renderer against a fixture dataset.
 *
 * Writes agent-outputs/sample-aircons.html and prints the path. Open the
 * file in a browser to inspect the visual output.
 *
 *   node scripts/preview-comparison-report.js
 *
 * No runner integration, no network — purely renders the fixture so you
 * can sign off on the layout before Slice 4.6.1 wires real data.
 */
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  // The renderer is TypeScript; require the built JS if present, else
  // fall back to ts-node-style on-the-fly compile via the Jest pipeline.
  let renderComparisonReport, loadPreset;
  try {
    // Try the compiled build first (after `npm run build`).
    ({ renderComparisonReport } = require(path.join('..', 'dist', 'src', 'reports', 'comparisonReport')));
    ({ loadPreset } = require(path.join('..', 'dist', 'src', 'services', 'comparisonSchema')));
  } catch {
    // No dist build; compile the two source files in-process via tsc.
    require('child_process').execSync(
      'npx tsc src/reports/comparisonReport.ts src/services/comparisonSchema.ts --outDir .preview-build --module commonjs --target es2020 --esModuleInterop --skipLibCheck',
      { stdio: 'inherit', cwd: path.resolve(__dirname, '..') },
    );
    // comparisonSchema resolves presets via __dirname/../presets; mirror
    // the preset files into the build dir so the loader finds them.
    const srcPresets = path.resolve(__dirname, '..', 'src', 'presets');
    const dstPresets = path.resolve(__dirname, '..', '.preview-build', 'presets');
    fs.mkdirSync(dstPresets, { recursive: true });
    for (const f of fs.readdirSync(srcPresets)) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(srcPresets, f), path.join(dstPresets, f));
    }
    ({ renderComparisonReport } = require(path.resolve(__dirname, '..', '.preview-build', 'reports', 'comparisonReport')));
    ({ loadPreset } = require(path.resolve(__dirname, '..', '.preview-build', 'services', 'comparisonSchema')));
  }

  const schema = await loadPreset('aircons');
  if (!schema) throw new Error('aircons preset not found');

  const dataset = {
    title: 'Portable aircons under $500',
    goal: 'Find me the best value portable aircons under $500 — focus on quiet, energy-efficient models for a 30 m² bedroom.',
    generatedAt: new Date().toISOString(),
    rows: [
      { model: 'CoolBlast 9000',  price_usd: 329, btu: 9000,  noise_db: 52, energy_class: 'A',   weight_kg: 25, url: 'https://example.com/coolblast-9000' },
      { model: 'BreezeMax Pro',   price_usd: 449, btu: 12000, noise_db: 49, energy_class: 'A+',  weight_kg: 31, url: 'https://example.com/breezemax-pro' },
      { model: 'ChillTech Mini',  price_usd: 249, btu: 7000,  noise_db: 58, energy_class: 'B',   weight_kg: 22, url: 'https://example.com/chilltech-mini' },
      { model: 'FrostWave Elite', price_usd: 479, btu: 10000, noise_db: 46, energy_class: 'A++', weight_kg: 28, url: 'https://example.com/frostwave-elite' },
      { model: 'ArcticBreeze 8',  price_usd: 379, btu: 8500,  noise_db: 51, energy_class: 'A',   weight_kg: 24, url: 'https://example.com/arcticbreeze-8' },
      { model: 'PolarFlow Max',   price_usd: 459, btu: 11000, noise_db: 48, energy_class: 'A+',  weight_kg: 30, url: 'https://example.com/polarflow-max' },
      { model: 'MysteryCool X',   price_usd: 399, btu: null,  noise_db: null, energy_class: null, weight_kg: 27, url: 'https://example.com/mysterycool-x' },
    ],
    sourcePages: [
      { url: 'https://example.com/aircons-roundup',    title: 'Best portable air conditioners 2026 — buyer\u2019s guide', fetchedAt: new Date(Date.now() - 1000 * 60 * 8).toISOString() },
      { url: 'https://example.com/coolblast-9000',     title: 'CoolBlast 9000 product page',                              fetchedAt: new Date(Date.now() - 1000 * 60 * 6).toISOString() },
      { url: 'https://example.com/breezemax-pro',      title: 'BreezeMax Pro product page',                               fetchedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString() },
      { url: 'https://example.com/frostwave-elite',    title: 'FrostWave Elite product page',                             fetchedAt: new Date(Date.now() - 1000 * 60 * 4).toISOString() },
      { url: 'https://example.com/aircons-energy-test', title: 'Energy efficiency testing of 12 portable aircons',         fetchedAt: new Date(Date.now() - 1000 * 60 * 2).toISOString() },
    ],
  };

  const html = renderComparisonReport(dataset, schema);

  const outDir = path.resolve(__dirname, '..', 'agent-outputs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'sample-aircons.html');
  fs.writeFileSync(outPath, html, 'utf-8');

  console.log('Wrote', outPath);
  console.log('Open it in a browser to preview the comparison report visual.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
