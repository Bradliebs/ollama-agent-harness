import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { getUploadsDir, maybeRedirectAgentOutput, resolveProjectPath, resolveProjectReadPath } from './pathResolution';

const DEFAULT_MAX_READ_BYTES = 100_000;
const MAX_ALLOWED_READ_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 5_000_000;

export const FileReadTool: Tool = {
  name: 'file_read',
  description: 'Read the contents of a file at the given path',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path to read' },
      start_line: { type: 'number', description: 'Optional 1-based line number to start reading from' },
      end_line: { type: 'number', description: 'Optional 1-based line number to stop reading at' },
      max_bytes: { type: 'number', description: 'Maximum bytes to return (default: 100000)' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectReadPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    const maxBytes = clampNumber(input.max_bytes, 1, MAX_ALLOWED_READ_BYTES, DEFAULT_MAX_READ_BYTES);
    try {
      const stat = await fs.stat(filePath);
      const raw = await fs.readFile(filePath, 'utf-8');
      const content = sliceLines(raw, input.start_line, input.end_line);
      const truncated = Buffer.byteLength(content, 'utf-8') > maxBytes;
      const output = truncateUtf8(content, maxBytes);
      const suffix = truncated || stat.size > maxBytes ? `\n...(truncated, file size ${stat.size} bytes)` : '';
      return { success: true, output: output + suffix };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read '${filePath}': ${msg}`, error: msg };
    }
  },
};

export const FileWriteTool: Tool = {
  name: 'file_write',
  description: 'Write content to a file, creating directories as needed',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const rawPath = String(input.path ?? '');
    // Bare-filename writes for new files get redirected into agent-outputs/
    // so the repo root does not become a dumping ground. Preserves intentional
    // writes to existing files and to explicit subdirectories.
    const redirected = maybeRedirectAgentOutput(rawPath);
    const filePath = redirected ?? resolveProjectPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    const content = input.content as string;
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
      return { success: false, output: `Write exceeds ${MAX_WRITE_BYTES} bytes`, error: 'write too large' };
    }
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      const note = redirected ? ` (redirected from bare filename to agent-outputs/)` : '';
      return { success: true, output: `Wrote ${content.length} chars to '${filePath}'${note}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to write '${filePath}': ${msg}`, error: msg };
    }
  },
};

export const FileEditTool: Tool = {
  name: 'file_edit',
  description: 'Replace an exact string in a file with a new string',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    const oldStr = input.old_string as string;
    const newStr = input.new_string as string;
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // First try exact match.
      let idx = content.indexOf(oldStr);
      let matched = oldStr;

      // Fallback 1: normalize line endings on both sides. Models frequently
      // emit \n while Windows-checked-out files have \r\n; without this the
      // edit fails even when the model has correct content.
      if (idx === -1) {
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const normalizedOld = oldStr.replace(/\r\n/g, '\n');
        const normIdx = normalizedContent.indexOf(normalizedOld);
        if (normIdx !== -1) {
          // Find the actual span in the original content by walking forward
          // and counting characters, accounting for \r\n vs \n.
          const span = findOriginalSpan(content, normIdx, normalizedOld.length);
          if (span) {
            idx = span.start;
            matched = content.slice(span.start, span.end);
          }
        }
      }

      if (idx === -1) {
        return { success: false, output: `String not found in '${filePath}'`, error: 'old_string not found' };
      }
      // Ensure unique match (against the same normalization that found idx)
      if (content.indexOf(matched, idx + 1) !== -1) {
        return { success: false, output: `Multiple matches for old_string in '${filePath}'`, error: 'ambiguous match' };
      }
      const updated = content.slice(0, idx) + newStr + content.slice(idx + matched.length);
      await fs.writeFile(filePath, updated, 'utf-8');
      return { success: true, output: `Edited '${filePath}': replaced ${matched.length} chars with ${newStr.length} chars` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to edit '${filePath}': ${msg}`, error: msg };
    }
  },
};

/**
 * Given the original (CRLF-mixed) file content and a position in its
 * line-ending-normalized projection, return the [start, end) span in the
 * original content that corresponds to `length` normalized characters.
 *
 * Walks both views in lockstep: each `\n` in the normalized projection
 * may correspond to either `\n` or `\r\n` in the original. Returns null
 * if the boundaries don't align (defensive — should not happen).
 */
function findOriginalSpan(original: string, normStart: number, normLength: number): { start: number; end: number } | null {
  let oi = 0; // index into original
  let ni = 0; // index into normalized projection
  while (ni < normStart && oi < original.length) {
    if (original[oi] === '\r' && original[oi + 1] === '\n') { oi += 2; ni += 1; }
    else { oi += 1; ni += 1; }
  }
  if (ni !== normStart) return null;
  const start = oi;
  let remaining = normLength;
  while (remaining > 0 && oi < original.length) {
    if (original[oi] === '\r' && original[oi + 1] === '\n') { oi += 2; remaining -= 1; }
    else { oi += 1; remaining -= 1; }
  }
  if (remaining !== 0) return null;
  return { start, end: oi };
}

export const ListFilesTool: Tool = {
  name: 'list_files',
  description: 'List files and directories at the given path',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = resolveProjectPath(input.path);
    if (!dirPath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const listing = entries
        .map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
        .join('\n');
      return { success: true, output: listing || '(empty directory)' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to list '${dirPath}': ${msg}`, error: msg };
    }
  },
};

export const ListUploadsTool: Tool = {
  name: 'list_uploads',
  description: 'List files attached by the user via the Harness UI (stored in .harness/uploads/). Use this to discover the exact path and name of every attachment before reading or analyzing it.',
  parameters: {
    type: 'object',
    properties: {},
  },
  isReadOnly: true,
  async execute(): Promise<ToolResult> {
    const uploadsDir = getUploadsDir();
    try {
      const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
      const files: Array<{ name: string; path: string; size: number; modified: string }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(uploadsDir, entry.name);
        const stat = await fs.stat(full);
        const cwdRel = path.relative(process.cwd(), full);
        const display = cwdRel.startsWith('..') ? full : cwdRel;
        files.push({
          name: entry.name,
          path: display.split(path.sep).join('/'),
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
      if (files.length === 0) {
        return { success: true, output: '(no uploads)' };
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      const lines = files.map((f) => `${f.path}\t${f.size} bytes\t${f.modified}`);
      return { success: true, output: lines.join('\n') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return { success: true, output: '(no uploads)' };
      }
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to list uploads: ${msg}`, error: msg };
    }
  },
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function sliceLines(content: string, startValue: unknown, endValue: unknown): string {
  const startLine = Number(startValue);
  const endLine = Number(endValue);
  if (!Number.isFinite(startLine) && !Number.isFinite(endLine)) return content;
  const lines = content.split('\n');
  const startIndex = Number.isFinite(startLine) ? Math.max(0, Math.floor(startLine) - 1) : 0;
  const endIndex = Number.isFinite(endLine) ? Math.max(startIndex, Math.floor(endLine)) : lines.length;
  return lines.slice(startIndex, endIndex).join('\n');
}

function truncateUtf8(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, 'utf-8');
  if (buffer.length <= maxBytes) return content;
  return buffer.subarray(0, maxBytes).toString('utf-8');
}
