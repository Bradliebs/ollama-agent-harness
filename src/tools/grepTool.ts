import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { resolveProjectPath } from './pathResolution';

const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_MATCHES = 200;

// Directories grep skips by default. Scratch surfaces (`agent-outputs/`,
// `.harness/uploads/`) accumulate stale model output and uploaded
// attachments that nearly always pollute later searches with off-topic
// matches — observed on a HybridTurtle session where a 2-day-old VW
// car-finder report was returned for a "trading" query. Callers can
// opt back in with `include_scratch: true`.
const ALWAYS_EXCLUDED_DIRS = new Set(['node_modules', 'dist']);
const SCRATCH_DIRS = new Set(['agent-outputs']);
const SCRATCH_PATH_FRAGMENTS = ['.harness/uploads', '.harness\\uploads'];

export const GrepTool: Tool = {
  name: 'grep',
  description: 'Search for a pattern in files. Returns matching lines with file paths and line numbers. Skips agent-outputs/ and .harness/uploads/ unless include_scratch is true.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in' },
      include: { type: 'string', description: 'Glob pattern for files to include (e.g. "*.ts")' },
      include_scratch: { type: 'boolean', description: 'When true, do NOT skip agent-outputs/ and .harness/uploads/' },
    },
    required: ['pattern', 'path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = resolveProjectPath(input.path);
    const include = input.include as string | undefined;
    const includeScratch = input.include_scratch === true;

    if (!searchPath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }

    try {
      const results: string[] = [];
      await searchDir(searchPath, pattern, include, results, 0, includeScratch);

      if (results.length === 0) {
        return { success: true, output: `No matches found for "${pattern}"` };
      }

      const output = results.slice(0, MAX_MATCHES).join('\n');
      const suffix = results.length > MAX_MATCHES ? `\n...(${results.length - MAX_MATCHES} more matches)` : '';
      return { success: true, output: output + suffix };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Grep failed: ${msg}`, error: msg };
    }
  },
};

async function searchDir(
  dirPath: string,
  pattern: string,
  include: string | undefined,
  results: string[],
  depth: number,
  includeScratch: boolean,
): Promise<void> {
  if (depth > 10 || results.length > MAX_MATCHES) return;

  if (!includeScratch) {
    const normalized = dirPath.replace(/\\/g, '/');
    for (const fragment of SCRATCH_PATH_FRAGMENTS) {
      const fragNormal = fragment.replace(/\\/g, '/');
      if (normalized.includes(fragNormal)) return;
    }
  }

  const stat = await fs.stat(dirPath);
  if (stat.isFile()) {
    await searchFile(dirPath, pattern, results);
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ALWAYS_EXCLUDED_DIRS.has(entry.name)) continue;
    if (!includeScratch && SCRATCH_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await searchDir(fullPath, pattern, include, results, depth + 1, includeScratch);
    } else if (entry.isFile()) {
      if (include && !matchGlob(entry.name, include)) continue;
      await searchFile(fullPath, pattern, results);
    }
  }
}

async function searchFile(filePath: string, pattern: string, results: string[]): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_SEARCH_FILE_BYTES) {
      return;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    for (let i = 0; i < lines.length && results.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i])) {
        results.push(`${filePath}:${i + 1}: ${lines[i].trimEnd()}`);
      }
    }
  } catch {
    // Binary file or unreadable — skip
  }
}

function matchGlob(name: string, glob: string): boolean {
  const regex = glob
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(name);
}
