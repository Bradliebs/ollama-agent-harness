import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { applyFileWriteRedirect, getAllowedExternalPaths, getUploadsDir, maybeRedirectAgentOutput, resolveProjectPath, resolveProjectReadPath, setAllowedExternalPaths } from './pathResolution';
import { loadRepoGraph, analyzeImpact } from '../core/codeIntelligence';

const DEFAULT_MAX_READ_BYTES = 100_000;
const MAX_ALLOWED_READ_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 5_000_000;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

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
    // Redirect precedence:
    //   1. User-defined pattern rules (HARNESS_FILE_WRITE_REDIRECTS env or
    //      .harness/file-write-redirects.json) — highest priority so the
    //      user's intent always wins. May target paths OUTSIDE the project
    //      root (the whole point: route lottery-* into a sibling repo).
    //   2. Bare-filename agent-outputs/ redirect for new files (existing
    //      v0.2 behavior — keeps repo root from becoming a dumping ground).
    //   3. resolveProjectPath: confine to project root unless allowed.
    let filePath: string | null = applyFileWriteRedirect(rawPath);
    let redirectKind: 'pattern' | 'agent-outputs' | null = filePath ? 'pattern' : null;
    if (!filePath) {
      const bareRedirect = maybeRedirectAgentOutput(rawPath);
      if (bareRedirect) {
        filePath = bareRedirect;
        redirectKind = 'agent-outputs';
      } else {
        filePath = resolveProjectPath(input.path);
      }
    }
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
      const impactNote = await getImpactNote(filePath);
      // When a redirect happened, lead with the resolved absolute path on
      // its own line so the model picks it up for follow-up commands
      // (e.g. `python check_yfinance.py` previously failed because the
      // redirect note was a trailing parenthetical the model didn't
      // parse). Keep the "redirected by user pattern rule" /
      // "redirected from bare filename" substrings — other tooling and
      // tests match on them.
      if (redirectKind === 'pattern') {
        return {
          success: true,
          output:
            `✅ Saved to: ${filePath}\n` +
            `ℹ️ Path was redirected by user pattern rule. To run, read, or edit this file later, use the FULL path above (not the path you originally passed).\n` +
            `Wrote ${content.length} chars.${impactNote}`,
        };
      }
      if (redirectKind === 'agent-outputs') {
        return {
          success: true,
          output:
            `✅ Saved to: ${filePath}\n` +
            `ℹ️ Path was redirected from bare filename to agent-outputs/. To run, read, or edit this file later, use the FULL path above — bash auto-resolves bare script names from agent-outputs/, but for read/edit you must pass the full path.\n` +
            `Wrote ${content.length} chars.${impactNote}`,
        };
      }
      return { success: true, output: `Wrote ${content.length} chars to '${filePath}'${impactNote}` };
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
      const impactNote = await getImpactNote(filePath);
      return { success: true, output: `Edited '${filePath}': replaced ${matched.length} chars with ${newStr.length} chars${impactNote}` };
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

/**
 * Move (or rename) a file. The destination is created in its parent
 * directory; existing files at the destination are NOT overwritten by
 * default. Both source and destination must pass resolveProjectPath
 * confinement, so absolute paths into the user's configured Agent Files
 * folder work because that folder is auto-added to the allowed-paths
 * list when set in Settings.
 *
 * The agent uses this when the user asks "move my files to X". Without
 * this tool, the model can only emulate a move via file_read + file_write
 * which leaves the original in place — a frequent point of confusion.
 */
export const FileMoveTool: Tool = {
  name: 'file_move',
  description: 'Move or rename a file from one path to another. Both paths must be inside the project or an allowed external folder. Refuses to overwrite an existing file at the destination unless overwrite=true.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source file path' },
      to: { type: 'string', description: 'Destination file path' },
      overwrite: { type: 'boolean', description: 'When true, replace the destination if it already exists. Defaults to false.' },
    },
    required: ['from', 'to'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const fromPath = resolveProjectPath(input.from);
    const toPath = resolveProjectPath(input.to);
    if (!fromPath) return { success: false, output: 'Source path is outside the project directory', error: 'from outside project' };
    if (!toPath) return { success: false, output: 'Destination path is outside the project directory', error: 'to outside project' };
    if (fromPath === toPath) return { success: false, output: 'Source and destination are the same path', error: 'same path' };
    const overwrite = input.overwrite === true;
    try {
      // Source must exist and be a regular file. We reject directory
      // moves explicitly so an accidental "move my folder" call doesn't
      // sweep an entire subtree without the user realizing.
      const srcStat = await fs.stat(fromPath);
      if (!srcStat.isFile()) {
        return { success: false, output: `Source '${fromPath}' is not a regular file (file_move does not move directories)`, error: 'source not a file' };
      }
      // Destination existence check (unless overwrite). fs.rename on Windows
      // throws EEXIST in the cross-device case anyway; the explicit check
      // gives a clearer message.
      const dstExists = await fs.stat(toPath).then(() => true, () => false);
      if (dstExists && !overwrite) {
        return { success: false, output: `Destination '${toPath}' already exists. Pass overwrite=true to replace it.`, error: 'destination exists' };
      }
      await fs.mkdir(path.dirname(toPath), { recursive: true });
      try {
        await fs.rename(fromPath, toPath);
      } catch (renameErr) {
        // Cross-device move (e.g. project root on C:, target on D:): fs.rename
        // throws EXDEV. Fall back to copy + unlink so the move still succeeds.
        const code = (renameErr as NodeJS.ErrnoException).code;
        if (code === 'EXDEV') {
          await fs.copyFile(fromPath, toPath);
          await fs.unlink(fromPath);
        } else {
          throw renameErr;
        }
      }
      return { success: true, output: `Moved '${fromPath}' → '${toPath}'${overwrite && dstExists ? ' (replaced existing)' : ''}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to move '${fromPath}' → '${toPath}': ${msg}`, error: msg };
    }
  },
};

/**
 * Create a directory (and any missing parents). Exists primarily so the
 * agent has a cross-platform alternative to `mkdir`, which the bash tool
 * blocks on Windows because it's a cmd.exe built-in rather than a real
 * executable. Idempotent: succeeds when the directory already exists,
 * mirroring `fs.mkdir({ recursive: true })`. Refuses to "create" a path
 * that already exists as a regular file so the caller doesn't silently
 * end up with the wrong shape on disk.
 */
export const MakeDirectoryTool: Tool = {
  name: 'make_directory',
  description: 'Create a directory at the given path, including any missing parent directories. Idempotent — succeeds if the directory already exists. Use this instead of bash mkdir on Windows. Path must be inside the project or an allowed external folder.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to create' },
    },
    required: ['path'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = resolveProjectPath(input.path);
    if (!dirPath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    try {
      // If the path exists already, accept it only when it's a directory.
      // A pre-existing file at this path almost certainly means the agent
      // confused mkdir with file_write — fail loudly rather than silently
      // succeed.
      const existing = await fs.stat(dirPath).catch(() => null);
      if (existing && !existing.isDirectory()) {
        return { success: false, output: `'${dirPath}' already exists and is not a directory`, error: 'path exists as file' };
      }
      await fs.mkdir(dirPath, { recursive: true });
      const note = existing ? ' (already existed)' : '';
      return { success: true, output: `Created directory '${dirPath}'${note}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to create directory '${dirPath}': ${msg}`, error: msg };
    }
  },
};

/**
 * Delete a single file. Refuses to delete directories (even empty ones)
 * to avoid accidental subtree wipes — directory deletion remains a
 * deliberate operation done via bash with explicit user awareness.
 */
export const FileDeleteTool: Tool = {
  name: 'file_delete',
  description: 'Delete a single file. Refuses to delete directories. Path must be inside the project or an allowed external folder.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to delete' },
    },
    required: ['path'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectPath(input.path);
    if (!filePath) {
      return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return { success: false, output: `'${filePath}' is not a regular file (file_delete refuses to remove directories)`, error: 'not a file' };
      }
      await fs.unlink(filePath);
      return { success: true, output: `Deleted '${filePath}'` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to delete '${filePath}': ${msg}`, error: msg };
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

/**
 * Slice content by 1-based, inclusive line numbers.
 *
 * Semantics: `startValue=1, endValue=10` returns the first 10 lines (lines 1
 * through 10 inclusive). Both bounds are 1-based to match common editor and
 * grep conventions. Either bound may be omitted (defaults: start=1,
 * end=lastLine). Non-finite values are treated as missing.
 */
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

/** Best-effort impact analysis for a changed file. Returns a note string or empty. */
async function getImpactNote(filePath: string): Promise<string> {
  try {
    // Invalidate cached repo graph when a code file is changed.
    if (CODE_EXTS.has(path.extname(filePath))) {
      invalidateRepoGraphCache(filePath).catch(() => {});
    }
    // Resolve project root from the file path (walk up to find package.json).
    let dir = path.dirname(filePath);
    let projectDir: string | null = null;
    for (let i = 0; i < 10; i++) {
      try {
        await fs.access(path.join(dir, 'package.json'));
        projectDir = dir;
        break;
      } catch { /* keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!projectDir) return '';

    // Hint to validate TypeScript when a .ts/.tsx file changes in a project
    // that has a tsconfig.json. Cheap to compute and gives the model a clear
    // next step ("run tsc") rather than declaring success on uncompiled code.
    const ext = path.extname(filePath);
    const tsHint = (ext === '.ts' || ext === '.tsx') && await fileExists(path.join(projectDir, 'tsconfig.json'))
      ? ' [validate: run `npx tsc --noEmit` before declaring done]'
      : '';

    const graph = await loadRepoGraph(projectDir);
    if (!graph) return tsHint;
    const relPath = path.relative(projectDir, filePath).split(path.sep).join('/');
    const impact = analyzeImpact(graph, [relPath]);
    if (impact.affected_tests.length === 0 && impact.direct.length === 0) return tsHint;
    const parts: string[] = [];
    if (impact.affected_tests.length > 0) {
      parts.push(`Tests to run: ${impact.affected_tests.slice(0, 5).join(', ')}`);
    }
    if (impact.direct.length > 0) {
      parts.push(`${impact.direct.length} direct importer(s)`);
    }
    if (impact.risk_score > 0.3) {
      parts.push(`risk: ${Math.round(impact.risk_score * 100)}%`);
    }
    return parts.length > 0 ? ` [Impact: ${parts.join(' · ')}]${tsHint}` : tsHint;
  } catch {
    return '';
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Delete the cached repo graph so it's rebuilt on next access. */
async function invalidateRepoGraphCache(filePath: string): Promise<void> {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 10; i++) {
    const graphPath = path.join(dir, '.harness', 'code-intelligence', 'repo-graph.json');
    try {
      await fs.access(graphPath);
      await fs.unlink(graphPath);
      return;
    } catch { /* not found, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export const AddWorkspacePathTool: Tool = {
  name: 'add_workspace_path',
  description: 'Grant the file tools (file_read, file_write, list_files) access to a folder outside the project root. Call this whenever the user mentions or pastes a path that is outside the project — e.g. "D:\\Brad\\Downloads\\my-project" — so that subsequent file operations succeed without permission errors. The folder is added to the session\'s Allowed External Paths list.',
  parameters: {
    type: 'object',
    properties: {
      folder_path: { type: 'string', description: 'Absolute path to the folder to allow, e.g. D:\\Brad\\Downloads\\update-lottery' },
    },
    required: ['folder_path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const raw = String(input.folder_path ?? '').trim();
    if (!raw) return { success: false, output: 'folder_path is required', error: 'missing folder_path' };
    const resolved = path.resolve(raw);
    if (resolved.length <= 3) return { success: false, output: 'Path is too short (root-level paths are not allowed)', error: 'path too short' };
    const existing = getAllowedExternalPaths();
    for (const p of existing) {
      if (path.resolve(p) === resolved) {
        return { success: true, output: `Already allowed: ${resolved}` };
      }
    }
    setAllowedExternalPaths([...existing, resolved]);
    return { success: true, output: `Allowed: ${resolved}\nYou can now use file_read, file_write, and list_files on files inside this folder.` };
  },
};
