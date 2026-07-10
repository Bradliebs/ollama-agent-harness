/**
 * blueprint-personal-wiki.ts — CopilotForge Cookbook Recipe
 *
 * Renders a browsable static "memory wiki" from a list of entries pulled
 * from the harness's semantic memory store (or any other source that
 * adopts the EntryLike shape).
 *
 * The implementation lives in `src/services/personalWiki.ts` so it compiles
 * into `dist/` and can be loaded by the production server (`npm run serve`).
 * This recipe re-exports that module and adds a standalone CLI wrapper.
 *
 * Usage (standalone, with a JSON input file):
 *   ts-node cookbook/blueprint-personal-wiki.ts <entries.json> <output-dir>
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildPersonalWiki } from '../src/services/personalWiki';
import type { MemoryEntryLike } from '../src/services/personalWiki';

export { buildPersonalWiki } from '../src/services/personalWiki';
export type { MemoryEntryLike, BuildWikiResult, BuildWikiOptions } from '../src/services/personalWiki';

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
}
