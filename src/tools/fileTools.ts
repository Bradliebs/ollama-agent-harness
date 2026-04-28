import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

export const FileReadTool: Tool = {
  name: 'file_read',
  description: 'Read the contents of a file at the given path',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path to read' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = input.path as string;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, output: content };
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
    const filePath = input.path as string;
    const content = input.content as string;
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
    const filePath = input.path as string;
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
    const dirPath = input.path as string;
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
