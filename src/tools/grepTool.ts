import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

export const GrepTool: Tool = {
  name: 'grep',
  description: 'Search for a pattern in files. Returns matching lines with file paths and line numbers.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in' },
      include: { type: 'string', description: 'Glob pattern for files to include (e.g. "*.ts")' },
    },
    required: ['pattern', 'path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = input.path as string;
    const include = input.include as string | undefined;

    try {
      const results: string[] = [];
      await searchDir(searchPath, pattern, include, results, 0);

      if (results.length === 0) {
        return { success: true, output: `No matches found for "${pattern}"` };
      }

      const output = results.slice(0, 200).join('\n');
      const suffix = results.length > 200 ? `\n...(${results.length - 200} more matches)` : '';
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
): Promise<void> {
  if (depth > 10 || results.length > 200) return;

  const stat = await fs.stat(dirPath);
  if (stat.isFile()) {
    await searchFile(dirPath, pattern, results);
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await searchDir(fullPath, pattern, include, results, depth + 1);
    } else if (entry.isFile()) {
      if (include && !matchGlob(entry.name, include)) continue;
      await searchFile(fullPath, pattern, results);
    }
  }
}

async function searchFile(filePath: string, pattern: string, results: string[]): Promise<void> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    for (let i = 0; i < lines.length && results.length < 200; i++) {
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
