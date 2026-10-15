// @-file mentions in chat messages, like Claude Code, Cursor and Cline:
// the composer autocompletes project paths after "@", and the chat route
// inlines the mentioned files so the model does not need a file_read round
// trip (which small local models often get wrong).

import * as fs from 'fs/promises';
import * as path from 'path';
import { SKIPPED_DIRS } from '../tools/grepTool';

const MAX_MENTIONED_FILES = 5;
const MAX_CHARS_PER_FILE = 12_000;
const BINARY_SNIFF_BYTES = 8_000;
/** Never inline harness state (keys, settings, sessions) or git internals. */
// Compared case-insensitively and without trailing dots or spaces, which Windows ignores.
const BLOCKED_SEGMENTS = new Set(['.harness', '.git']);

/** Paths written as @path in a message (trailing punctuation dropped), in order, without duplicates. */
export function extractFileMentions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s(])@([^\s@`'"<>]+)/g)) {
    const raw = match[1].replace(/[.,;:!?)\]]+$/, '');
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

export interface MentionedFilesOptions {
  projectDir: string;
  /** Resolves a user-written path the same way the file tools do; null when not allowed. */
  resolvePath: (value: string) => string | null;
  /** Total characters the inlined files may use. */
  maxTotalChars: number;
}

const WHOLE_READ_BYTES = 1_000_000;

export interface MentionedFilesResult {
  /** The context block, or null when no mentioned file could be included. */
  block: string | null;
  /** Files that were included, with whether they were cut short. */
  included: Array<{ path: string; truncated: boolean }>;
  /** Mentions that look like file names (have an extension) but were not found or not allowed. */
  notFound: string[];
}

/**
 * The context block for the files a message mentions with @. Mentions that
 * are not files (e.g. @someone, @Component) are ignored; directories,
 * binaries and blocked paths are skipped. Only as much of a file as can be
 * shown is read, so mentioning a huge log is cheap.
 */
export async function buildMentionedFilesBlock(text: string, options: MentionedFilesOptions): Promise<MentionedFilesResult> {
  const sections: string[] = [];
  const included: MentionedFilesResult['included'] = [];
  const notFound: string[] = [];
  let budget = options.maxTotalChars;
  for (const mention of extractFileMentions(text).slice(0, MAX_MENTIONED_FILES * 2)) {
    if (sections.length >= MAX_MENTIONED_FILES || budget <= 0) break;
    const looksLikeFile = /\.\w{1,8}$/.test(mention);
    const absolute = options.resolvePath(mention);
    const relative = absolute ? path.relative(options.projectDir, absolute) : '';
    if (!absolute || relative.split(/[\\/]/).some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase().replace(/[. ]+$/, '')))) {
      if (looksLikeFile) notFound.push(mention);
      continue;
    }
    const limit = Math.min(MAX_CHARS_PER_FILE, budget);
    let buffer: Buffer;
    let size: number;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      size = stat.size;
      // Files up to 1 MB are read whole (so the note can give the line count);
      // for bigger ones only what can be shown is read (UTF-8 is at most 4 bytes a character).
      const handle = await fs.open(absolute, 'r');
      try {
        const want = Math.min(size, Math.max(limit * 4 + 1, WHOLE_READ_BYTES));
        buffer = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buffer, 0, want, 0);
        buffer = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      if (looksLikeFile) notFound.push(mention);
      continue;
    }
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    const content = buffer.toString('utf-8');
    const readWhole = buffer.length >= size;
    let shown = content;
    let note = '';
    if (content.length > limit || !readWhole) {
      // Cut at a whole line and say where to continue, as file_read does.
      const lines = content.split('\n');
      let used = 0;
      let count = 0;
      while (count < lines.length - (readWhole ? 0 : 1) && used + lines[count].length + 1 <= limit) { used += lines[count].length + 1; count += 1; }
      shown = lines.slice(0, count).join('\n');
      note = readWhole
        ? `\n(showing lines 1-${count} of ${lines.length}; read the rest with file_read start_line=${count + 1})`
        : `\n(showing lines 1-${count}; the file is ${size} bytes, read the rest with file_read start_line=${count + 1})`;
    }
    budget -= shown.length;
    const display = relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative.split(path.sep).join('/');
    sections.push(`### ${display}\n\`\`\`\n${shown}\n\`\`\`${note}`);
    included.push({ path: display, truncated: note !== '' });
  }
  if (sections.length === 0) return { block: null, included, notFound };
  return {
    block: [
      '--- Files the user mentioned with @ (current contents) ---',
      'These are the files as they are on disk right now; use them instead of reading them again. Edit them with their path.',
      ...sections,
    ].join('\n'),
    included,
    notFound,
  };
}

interface FileListCache { at: number; files: string[] }
const fileListCache = new Map<string, FileListCache>();
const FILE_LIST_TTL_MS = 15_000;
const MAX_LISTED_FILES = 20_000;

async function listProjectFiles(projectDir: string): Promise<string[]> {
  const cached = fileListCache.get(projectDir);
  if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
  const files: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 12 || files.length >= MAX_LISTED_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name) || entry.name === 'agent-outputs') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel, depth + 1);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  await walk(projectDir, '', 0);
  fileListCache.set(projectDir, { at: Date.now(), files });
  return files;
}

/**
 * Project files matching a query for the @ autocomplete: file names that
 * start with the query first, then names containing it, then paths
 * containing it (case-insensitive). An empty query lists the first files.
 */
export async function searchProjectFiles(projectDir: string, query: string, limit = 20): Promise<string[]> {
  const files = await listProjectFiles(projectDir);
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!q) return files.slice(0, limit);
  const rank = (file: string): number => {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (base.startsWith(q)) return 0;
    if (base.includes(q)) return 1;
    if (lower.includes(q)) return 2;
    return -1;
  };
  return files
    .map((file) => ({ file, score: rank(file) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((entry) => entry.file);
}
