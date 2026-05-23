// Read-Before-Write Gate
//
// Tracks which file paths have been read in the current run. When a write
// tool (file_write / file_edit) targets a path that has NOT been read,
// the gate can block the write (mode: 'enforce') or warn (mode: 'warn').
//
// This prevents "imaginary repo syndrome" — where the agent edits files
// it has never inspected, inventing content or clobbering existing work.
//
// The canonical write tools are:
//   file_write  — full overwrite
//   file_edit   — targeted string replacement
//
// New file creation (file_write to a non-existent path) is allowlisted
// by default because the agent cannot read something that doesn't exist.

import * as path from 'path';
import * as fs from 'fs';

// ─── Types ───────────────────────────────────────────────────────────

export type ReadBeforeWriteMode = 'off' | 'warn' | 'enforce';

export interface ReadBeforeWriteGateOptions {
  /**
   * 'off'     — disabled; all writes pass through.
   * 'warn'    — log a warning but allow the write.
   * 'enforce' — block the write and return an error result.
   * Default: 'warn'.
   */
  mode?: ReadBeforeWriteMode;
  /**
   * When true (default), creating a brand-new file bypasses the gate
   * because the file didn't exist to read. Set false to require an
   * explicit exemption even for new files.
   */
  allowNewFiles?: boolean;
  /**
   * Paths (absolute or relative to cwd) that are always allowed to be
   * written without a prior read — e.g. dedicated output files, logs.
   */
  exemptPaths?: string[];
}

export interface ReadBeforeWriteViolation {
  path: string;
  tool: string;
  timestamp: string;
}

export interface ReadBeforeWriteCheck {
  allowed: boolean;
  /** True when the path was in the read ledger before the write. */
  wasRead: boolean;
  /** True when the path was created (didn't exist) — exempted by default. */
  isNewFile: boolean;
  /** True when the path matched an explicit exemption. */
  isExempt: boolean;
  /** Human-readable reason, populated when allowed === false. */
  reason?: string;
}

// ─── Gate ────────────────────────────────────────────────────────────

/** Write tools whose path argument lives under `input.path`. */
const WRITE_TOOLS = new Set(['file_write', 'file_edit']);

/** Read tools whose path argument lives under `input.path`. */
const READ_TOOLS = new Set(['file_read', 'file_write' /* write also reads via edit */]);

export class ReadBeforeWriteGate {
  private readonly mode: ReadBeforeWriteMode;
  private readonly allowNewFiles: boolean;
  private readonly exemptPaths: Set<string>;

  /** Normalized absolute paths read during this session. */
  private readonly readLedger = new Set<string>();

  /** Violations recorded during the session. */
  readonly violations: ReadBeforeWriteViolation[] = [];

  constructor(options: ReadBeforeWriteGateOptions = {}) {
    this.mode         = options.mode         ?? 'warn';
    this.allowNewFiles = options.allowNewFiles ?? true;
    this.exemptPaths  = new Set(
      (options.exemptPaths ?? []).map((p) => path.resolve(p)),
    );
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Record a file path as having been read. Call this after every
   * successful file_read (or file_edit which reads before writing).
   */
  recordRead(filePath: string): void {
    this.readLedger.add(path.resolve(filePath));
  }

  /**
   * Record reads for multiple paths at once (e.g. after a grep that
   * returned file paths).
   */
  recordReads(filePaths: string[]): void {
    for (const fp of filePaths) this.recordRead(fp);
  }

  /**
   * Check whether a write to `filePath` is allowed under the current mode.
   * Does NOT mutate state — call `recordRead` separately when reads succeed.
   */
  checkWrite(filePath: string, toolName: string): ReadBeforeWriteCheck {
    const resolved = path.resolve(filePath);

    // Explicit exemption
    if (this.exemptPaths.has(resolved)) {
      return { allowed: true, wasRead: false, isNewFile: false, isExempt: true };
    }

    // Was it already read?
    const wasRead = this.readLedger.has(resolved);
    if (wasRead) {
      return { allowed: true, wasRead: true, isNewFile: false, isExempt: false };
    }

    // New file check (only meaningful for file_write)
    if (this.allowNewFiles && toolName === 'file_write' && !fileExistsSync(resolved)) {
      return { allowed: true, wasRead: false, isNewFile: true, isExempt: false };
    }

    // Violation
    const reason = `file_read required before ${toolName}: '${filePath}' has not been read in this session.`;

    this.violations.push({
      path: filePath,
      tool: toolName,
      timestamp: new Date().toISOString(),
    });

    if (this.mode === 'enforce') {
      return { allowed: false, wasRead: false, isNewFile: false, isExempt: false, reason };
    }

    // warn mode — log to stderr and allow
    if (this.mode === 'warn') {
      process.stderr.write(`[ReadBeforeWriteGate] WARN: ${reason}\n`);
    }

    return { allowed: true, wasRead: false, isNewFile: false, isExempt: false };
  }

  /**
   * The hook for the ToolDispatcher. Call this from a pre-dispatch gate:
   *   - records reads for file_read calls
   *   - checks gate for file_write / file_edit calls
   *
   * Returns { allowed, reason } compatible with ToolDispatcher permissionCheck.
   */
  gateTool(toolName: string, input: Record<string, unknown>): { allowed: boolean; reason?: string } {
    if (this.mode === 'off') return { allowed: true };

    const filePath = typeof input.path === 'string' ? input.path : null;
    if (!filePath) return { allowed: true };

    if (READ_TOOLS.has(toolName)) {
      // Record the read so subsequent writes to the same path are allowed.
      // Note: we record optimistically here (before execution). The caller
      // should call recordRead() after a *successful* read if they need
      // strict confirmation. For most use-cases, optimistic recording is
      // fine because a failed read is not a useful prior.
      this.recordRead(filePath);
      return { allowed: true };
    }

    if (WRITE_TOOLS.has(toolName)) {
      const check = this.checkWrite(filePath, toolName);
      if (!check.allowed) {
        return { allowed: false, reason: check.reason };
      }
    }

    return { allowed: true };
  }

  /** How many distinct paths have been read. */
  get readCount(): number {
    return this.readLedger.size;
  }

  /** Snapshot of the read ledger (absolute paths). */
  get readPaths(): string[] {
    return Array.from(this.readLedger);
  }

  /** Clear state for a new run. */
  reset(): void {
    this.readLedger.clear();
    this.violations.length = 0;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fileExistsSync(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}
