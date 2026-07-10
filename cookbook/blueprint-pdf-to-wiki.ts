/**
 * blueprint-pdf-to-wiki.ts — CopilotForge Cookbook Recipe
 *
 * Apex-style one-shot demo: hand it a PDF, walk away, come back to a
 * browsable wiki + a RAG index + a tiny self-contained chat page that
 * queries the index.
 *
 * The implementation lives in `src/services/pdfToWiki.ts` so it compiles
 * into `dist/` and can be loaded by the production server (`npm run serve`).
 * This recipe re-exports that module and adds a standalone CLI wrapper.
 *
 * Usage:
 *   ts-node cookbook/blueprint-pdf-to-wiki.ts <input.pdf> <output-dir>
 *   ts-node cookbook/blueprint-pdf-to-wiki.ts ./big.pdf ./out
 *
 * Environment:
 *   OLLAMA_HOST   — embeddings server (default http://localhost:11434)
 *   HARNESS_RAG_BACKEND — "ollama" or "hash" (default: auto-detect)
 */

import { buildBlueprint } from '../src/services/pdfToWiki';

export { buildBlueprint, detectChapters } from '../src/services/pdfToWiki';
export type { Chapter, BlueprintResult, BuildBlueprintOptions } from '../src/services/pdfToWiki';

// ─── CLI entry point ────────────────────────────────────────────────

if (require.main === module) {
  const [, , pdfArg, outArg] = process.argv;
  if (!pdfArg || !outArg) {
    process.stderr.write('Usage: ts-node cookbook/blueprint-pdf-to-wiki.ts <input.pdf> <output-dir>\n');
    process.exit(1);
  }
  buildBlueprint(pdfArg, outArg).then(
    (result) => {
      process.stdout.write(`[blueprint] ✅ Wiki built at ${result.outputDir}\n`);
      process.stdout.write(`[blueprint]    ${result.chapters.length} chapter(s)\n`);
      process.stdout.write(`[blueprint]    Index:    ${result.files.index}\n`);
      process.stdout.write(`[blueprint]    Chat:     ${result.files.chat}\n`);
      process.stdout.write(`[blueprint]    RAG:      ${result.files.ragIndex || '(skipped)'}\n`);
    },
    (err) => {
      process.stderr.write(`[blueprint] ❌ ${err && err.stack || err}\n`);
      process.exit(2);
    },
  );
}
