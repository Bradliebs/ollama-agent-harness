/**
 * comparisonSchema — preset registry + loader for comparison reports.
 *
 * A "comparison schema" describes one category (aircons, laptops, etc.):
 * the human title, alias strings the goal-detector matches against, and
 * the column list that drives both the dataset shape and the rendered
 * HTML report. Schemas are JSON in `src/presets/` so non-coders can add
 * a category by dropping a file in.
 *
 * Slice 4.6.0 ships the preset loader only. Slice 4.8 adds the
 * inferred-schema fallback (LLM proposes a schema when no preset
 * matches).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type ColumnType = 'string' | 'number' | 'enum' | 'url';
export type ColumnDirection = 'lower-better' | 'higher-better' | 'enum-better';

export interface ComparisonColumn {
  /** Stable identifier; also the row dictionary key. */
  key: string;
  /** Display label in the table header. */
  label: string;
  /** Data type — drives formatting and sort comparator. */
  type: ColumnType;
  /** Optional unit suffix or prefix ($ is rendered as a prefix; everything else as a suffix). */
  unit?: string;
  /** Scoring direction. Only set when the column should contribute to value-score. */
  direction?: ColumnDirection;
  /** For enum columns: ordered best-to-worst. Indices are used for ranking. */
  enumValues?: string[];
  /** Weight in the value-score formula (0..1). Sum across all scored columns can be < 1; the renderer normalises. */
  weight?: number;
}

export interface ComparisonSchema {
  /** Lower-case category id. */
  category: string;
  /** Free-form strings the goal detector matches against (substring, case-insensitive). */
  aliases: string[];
  /** Human title for the report header. */
  title: string;
  /** Column definitions, in the order they should appear in the table. */
  columns: ComparisonColumn[];
}

/** All presets shipped with the harness. Resolved relative to this file at build time. */
const PRESETS_DIR = path.join(__dirname, '..', 'presets');

/**
 * Load a preset by category id (e.g. `aircons`). Returns `null` when the
 * preset does not exist so callers can fall through to the inferred-schema
 * path. Throws on malformed JSON because that is a deploy-time bug, not a
 * runtime miss.
 */
export async function loadPreset(category: string): Promise<ComparisonSchema | null> {
  const safe = category.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  if (!safe) return null;
  const file = path.join(PRESETS_DIR, `${safe}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as ComparisonSchema;
  validateSchema(parsed, file);
  return parsed;
}

/**
 * List the categories that have presets. Used by the goal detector to
 * match alias strings without loading every file.
 */
export async function listPresetCategories(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PRESETS_DIR);
    return entries.filter((e) => e.endsWith('.json')).map((e) => e.replace(/\.json$/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Find a preset whose aliases match the intent text. Substring,
 * case-insensitive. Returns the first match — preset files are expected
 * to use non-overlapping aliases.
 */
export async function findPresetForIntent(intent: string): Promise<ComparisonSchema | null> {
  const haystack = intent.toLowerCase();
  const categories = await listPresetCategories();
  for (const category of categories) {
    const schema = await loadPreset(category);
    if (!schema) continue;
    if (schema.aliases.some((alias) => haystack.includes(alias.toLowerCase()))) return schema;
  }
  return null;
}

function validateSchema(schema: ComparisonSchema, file: string): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid preset ${file}: ${msg}`);
  };
  if (!schema.category || typeof schema.category !== 'string') fail('missing category');
  if (!Array.isArray(schema.aliases)) fail('aliases must be an array');
  if (!schema.title || typeof schema.title !== 'string') fail('missing title');
  if (!Array.isArray(schema.columns) || schema.columns.length === 0) fail('columns must be a non-empty array');
  for (const col of schema.columns) {
    if (!col.key || !col.label || !col.type) fail(`column missing key/label/type: ${JSON.stringify(col)}`);
    if (col.type === 'enum' && (!col.enumValues || col.enumValues.length === 0)) fail(`enum column ${col.key} missing enumValues`);
    if (col.direction === 'enum-better' && col.type !== 'enum') fail(`column ${col.key} uses enum-better direction but is not an enum`);
    if (col.weight !== undefined && (col.weight < 0 || col.weight > 1)) fail(`column ${col.key} weight out of 0..1`);
  }
}
