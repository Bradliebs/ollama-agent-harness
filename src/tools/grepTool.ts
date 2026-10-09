import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { getProjectRoot, resolveProjectPath } from './pathResolution';

const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_MATCHES = 200;
const MAX_LINE_CHARS = 300;

/**
 * Directories skipped while walking (they are still searched when passed as
 * `path` directly): dependencies, build output and caches, whose matches
 * drown the source. Dot-directories (.git, .venv, .next, ...) are always
 * skipped too. Shared with list_files.
 */
export const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', '__pycache__', 'vendor', 'bower_components']);

// Scratch surfaces (`agent-outputs/`, `.harness/uploads/`) accumulate stale
// model output and uploaded attachments that nearly always pollute later
// searches with off-topic matches — observed on a HybridTurtle session where
// a 2-day-old VW car-finder report was returned for a "trading" query.
// Callers can opt back in with `include_scratch: true`.
const SCRATCH_DIRS = new Set(['agent-outputs']);
const SCRATCH_PATH_FRAGMENTS = ['.harness/uploads'];

/**
 * Glob to RegExp: `**` spans directories, `*` and `?` stay within one path
 * segment, `{a,b}` alternates. A pattern without `/` matches the file name
 * alone; one with `/` matches the path relative to the search root.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') { i += 1; out += '(?:.*/)?'; } else out += '.*';
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '{') { braceDepth += 1; out += '(?:'; }
    else if (ch === '}' && braceDepth > 0) { braceDepth -= 1; out += ')'; }
    else if (ch === ',' && braceDepth > 0) out += '|';
    else out += ch.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** Whether a path (relative, `/`-separated) matches a glob from globToRegExp's rules. */
export function matchesGlob(relPath: string, glob: string, regex = globToRegExp(glob)): boolean {
  return regex.test(glob.includes('/') ? relPath : path.posix.basename(relPath));
}

/** Path shown to the model: relative to the project root when inside it (shorter, and what the file tools accept). */
export function displayPath(fullPath: string): string {
  const rel = path.relative(getProjectRoot(), fullPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : fullPath;
}

export const GrepTool: Tool = {
  name: 'grep',
  description: 'Search file contents for a regex (case-insensitive). Returns "path:line: text" with paths relative to the project root. Skips dependency/build folders (node_modules, dist, build, target, ...), dot-folders, binary files, agent-outputs/ and .harness/uploads/ unless include_scratch is true.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in (default: the project root)' },
      include: { type: 'string', description: 'Glob for files to search, e.g. "*.ts", "src/**/*.{ts,tsx}"' },
      include_scratch: { type: 'boolean', description: 'When true, do NOT skip agent-outputs/ and .harness/uploads/' },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(input.pattern ?? '');
    const searchPath = resolveProjectPath(typeof input.path === 'string' && input.path.trim() ? input.path : '.');
    const include = typeof input.include === 'string' && input.include.trim() ? input.include.trim() : undefined;
    const includeScratch = input.include_scratch === true;

    if (!searchPath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    try {
      const state: SearchState = { regex, include, includeRegex: include ? globToRegExp(include) : undefined, includeScratch, root: searchPath, results: [], capped: false };
      await searchDir(searchPath, state, 0);

      if (state.results.length === 0) {
        return { success: true, output: `No matches found for "${pattern}"` };
      }
      const suffix = state.capped ? `\n...(stopped at ${MAX_MATCHES} matches; narrow the pattern, path or include)` : '';
      return { success: true, output: state.results.join('\n') + suffix };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Grep failed: ${msg}`, error: msg };
    }
  },
};

interface SearchState {
  regex: RegExp;
  include?: string;
  includeRegex?: RegExp;
  includeScratch: boolean;
  root: string;
  results: string[];
  capped: boolean;
}

async function searchDir(dirPath: string, state: SearchState, depth: number): Promise<void> {
  if (depth > 10 || state.capped) return;

  if (!state.includeScratch) {
    const normalized = dirPath.replace(/\\/g, '/');
    if (SCRATCH_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return;
  }

  const stat = await fs.stat(dirPath);
  if (stat.isFile()) {
    await searchFile(dirPath, state);
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (state.capped) return;
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    if (!state.includeScratch && SCRATCH_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await searchDir(fullPath, state, depth + 1);
    } else if (entry.isFile()) {
      if (state.include) {
        // Match the glob from the search root or from the project root, so
        // "src/**/*.ts" works whether path is "." or "src".
        const fromRoot = path.relative(state.root, fullPath).split(path.sep).join('/');
        if (!matchesGlob(fromRoot, state.include, state.includeRegex) && !matchesGlob(displayPath(fullPath), state.include, state.includeRegex)) continue;
      }
      await searchFile(fullPath, state);
    }
  }
}

async function searchFile(filePath: string, state: SearchState): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_SEARCH_FILE_BYTES) return;
    const buffer = await fs.readFile(filePath);
    // A NUL byte early on means a binary file (images, archives, compiled output).
    if (buffer.subarray(0, 8_000).includes(0)) return;
    const lines = buffer.toString('utf-8').split('\n');
    const shown = displayPath(filePath);
    for (let i = 0; i < lines.length; i++) {
      // Drop a CRLF file's \r so patterns anchored with $ still match.
      const text = lines[i]!.endsWith('\r') ? lines[i]!.slice(0, -1) : lines[i]!;
      if (!state.regex.test(text)) continue;
      if (state.results.length >= MAX_MATCHES) {
        state.capped = true;
        return;
      }
      const line = text.trimEnd();
      state.results.push(`${shown}:${i + 1}: ${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`);
    }
  } catch {
    // Unreadable — skip
  }
}
