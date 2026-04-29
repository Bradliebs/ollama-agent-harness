import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

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
    const filePath = resolveProjectPath(input.path);
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
    const filePath = resolveProjectPath(input.path);
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
      return { success: true, output: `Wrote ${content.length} chars to '${filePath}'` };
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
      const idx = content.indexOf(oldStr);
      if (idx === -1) {
        return { success: false, output: `String not found in '${filePath}'`, error: 'old_string not found' };
      }
      // Ensure unique match
      if (content.indexOf(oldStr, idx + 1) !== -1) {
        return { success: false, output: `Multiple matches for old_string in '${filePath}'`, error: 'ambiguous match' };
      }
      const updated = content.replace(oldStr, newStr);
      await fs.writeFile(filePath, updated, 'utf-8');
      return { success: true, output: `Edited '${filePath}': replaced ${oldStr.length} chars with ${newStr.length} chars` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to edit '${filePath}': ${msg}`, error: msg };
    }
  },
};

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

function resolveProjectPath(value: unknown): string | null {
  const raw = String(value ?? '');
  const resolved = path.resolve(raw);
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

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
