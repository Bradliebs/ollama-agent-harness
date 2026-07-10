/**
 * blueprint-competitor-research.ts — CopilotForge Cookbook Recipe
 *
 * Renders a polished, self-contained HTML research report from a
 * structured `ResearchInput`. Pure composition — the gathering step
 * (web search, page reads, model analysis) is the caller's job. This
 * separation keeps the renderer testable offline and lets the autonomy
 * loop (`/goal research …` + agent tool calls) supply real data.
 *
 * The renderer itself lives in `src/services/researchReport.ts` so it
 * compiles into dist/ and can be loaded by the production server
 * (`npm run serve`). This recipe re-exports it and adds a standalone CLI.
 *
 * Usage (standalone, with a JSON input file):
 *   ts-node cookbook/blueprint-competitor-research.ts <input.json> <output.html>
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { writeResearchReport, type ResearchInput } from '../src/services/researchReport';

export {
  buildResearchReport,
  writeResearchReport,
} from '../src/services/researchReport';
export type {
  ResearchSource,
  ResearchFinding,
  ResearchInput,
  RenderedReport,
} from '../src/services/researchReport';

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
