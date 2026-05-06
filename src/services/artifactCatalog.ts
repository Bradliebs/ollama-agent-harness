// Cross-session artifact catalog.
//
// Surfaces files written by the agent into agent-outputs/ (the corralled
// scratch directory used by the file_write tool when it redirects bare
// filenames). The Artifacts UI tab uses this to give users a single
// view of every artifact the agent has produced, with light auto-tagging
// by extension so the table can group/filter without an LLM.
//
// Read-only and dependency-free — no fs writes, no daemons.

import * as fs from 'fs/promises';
import * as path from 'path';

export interface ArtifactRecord {
  /** Path relative to the artifact root (forward-slashed for stable display). */
  relativePath: string;
  /** File name without directory. */
  name: string;
  /** Absolute path on disk; useful for the read endpoint. */
  absolutePath: string;
  /** Size in bytes. */
  size: number;
  /** ISO modified timestamp. */
  modifiedAt: string;
  /** Lower-case file extension (without leading dot). */
  extension: string;
  /** Coarse category derived from extension. */
  category: ArtifactCategory;
  /** Auto-applied tags (extension, category, plus a couple of structural hints). */
  tags: string[];
}

export type ArtifactCategory =
  | 'code'
  | 'document'
  | 'data'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'web'
  | 'script'
  | 'other';

const EXTENSION_CATEGORIES: Record<string, ArtifactCategory> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', kt: 'code',
  swift: 'code', cs: 'code', cpp: 'code', c: 'code', h: 'code', hpp: 'code',
  md: 'document', markdown: 'document', txt: 'document', rtf: 'document',
  pdf: 'document', docx: 'document', odt: 'document',
  json: 'data', jsonl: 'data', yaml: 'data', yml: 'data', toml: 'data',
  csv: 'data', tsv: 'data', xml: 'data', xlsx: 'data',
  html: 'web', htm: 'web', svg: 'web', css: 'web',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video',
  zip: 'archive', tar: 'archive', gz: 'archive', '7z': 'archive', rar: 'archive',
  sh: 'script', ps1: 'script', bat: 'script', cmd: 'script',
};

const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;

export interface ListArtifactsOptions {
  /** Maximum number of records to return (default 200). */
  limit?: number;
  /** When set, restrict to artifacts with the given category. */
  category?: ArtifactCategory;
  /** When set, restrict to artifacts whose name contains the substring (case-insensitive). */
  search?: string;
}

/**
 * Walk the artifact root and return a flat list of artifacts ordered by
 * most-recently modified first. Returns an empty list if the root does
 * not exist; never throws.
 */
export async function listArtifacts(rootDir: string, options: ListArtifactsOptions = {}): Promise<ArtifactRecord[]> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const records: ArtifactRecord[] = [];
  await walk(rootDir, rootDir, records);
  let filtered = records;
  if (options.category) {
    filtered = filtered.filter((record) => record.category === options.category);
  }
  if (options.search) {
    const needle = options.search.toLowerCase();
    filtered = filtered.filter((record) => record.relativePath.toLowerCase().includes(needle));
  }
  filtered.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return filtered.slice(0, limit);
}

async function walk(rootDir: string, currentDir: string, records: ArtifactRecord[]): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(rootDir, absolute, records);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(absolute);
    } catch {
      continue;
    }
    const relativeRaw = path.relative(rootDir, absolute);
    const relativePath = relativeRaw.split(path.sep).join('/');
    const extension = path.extname(entry.name).replace(/^\./, '').toLowerCase();
    const category = EXTENSION_CATEGORIES[extension] ?? 'other';
    const tags = buildTags(entry.name, extension, category, stat.size);
    records.push({
      relativePath,
      name: entry.name,
      absolutePath: absolute,
      size: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      extension,
      category,
      tags,
    });
  }
}

function buildTags(name: string, extension: string, category: ArtifactCategory, size: number): string[] {
  const tags = new Set<string>();
  tags.add(category);
  if (extension) tags.add(extension);
  if (size >= 1_000_000) tags.add('large');
  if (size === 0) tags.add('empty');
  if (/report|summary|brief/i.test(name)) tags.add('report');
  if (/test|spec/i.test(name)) tags.add('test');
  if (/draft|wip/i.test(name)) tags.add('draft');
  return Array.from(tags);
}

export interface ReadArtifactResult {
  /** The on-disk path that was read. */
  absolutePath: string;
  /** UTF-8 contents, truncated to maxBytes. */
  content: string;
  /** True when the file was larger than maxBytes and the content was truncated. */
  truncated: boolean;
  /** Total file size in bytes (before truncation). */
  size: number;
  /** ISO modified timestamp. */
  modifiedAt: string;
}

/**
 * Read an artifact from inside `rootDir`. Refuses paths that escape the
 * root (path traversal protection). Returns up to maxBytes of UTF-8
 * content; binary files are reported by the caller via the extension
 * already exposed in `listArtifacts`.
 */
export async function readArtifact(rootDir: string, relativePath: string, maxBytes = DEFAULT_READ_MAX_BYTES): Promise<ReadArtifactResult> {
  if (!relativePath || relativePath.includes('..')) {
    throw new Error('Invalid artifact path.');
  }
  const absolute = path.resolve(rootDir, relativePath);
  const root = path.resolve(rootDir);
  if (!absolute.startsWith(root + path.sep) && absolute !== root) {
    throw new Error('Artifact path escapes the artifact root.');
  }
  const stat = await fs.stat(absolute);
  const buffer = await fs.readFile(absolute);
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return {
    absolutePath: absolute,
    content: slice.toString('utf-8'),
    truncated,
    size: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
  };
}
