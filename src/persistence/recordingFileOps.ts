// Recording file operations — the producer side of the side-effect ledger.
//
// Tools that mutate workspace files (write / delete) currently overwrite blindly
// and capture no pre-image, so nothing can be undone. These helpers perform the
// SAME fs mutation but first capture what was there, then record a reversible
// side effect attributed to a run. They are the boundary a file-producing tool
// calls instead of fs.writeFile/fs.unlink directly.
//
// Wiring the tools to call these (which requires threading a runId through the
// tool/dispatcher contract) is a separate concern; this module is the primitive.

import * as fs from 'fs/promises';
import * as path from 'path';
import { recordSideEffect, type SideEffect, type SideEffectInput } from './sideEffectLedger';

export interface TrackedFileOp {
  projectDir: string;
  /** Groups this effect with the rest of the run, so it reverts as a unit. */
  runId: string;
  /** File to operate on (absolute, or relative to projectDir). */
  filePath: string;
}

export interface TrackedWriteOp extends TrackedFileOp {
  content: string;
}

function resolvePath(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(projectDir, p);
}

/** Read a file's current content, or null if it does not exist. Rethrows other errors. */
export async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Build the ledger input for a file write given the pre-image. Existed -> a
 * file_modify whose reversal restores the prior content; absent -> a file_create
 * whose reversal deletes the new file. Pure; shared by writeFileTracked and the
 * dispatcher-boundary recorder so the reversal decision lives in one place.
 */
export function fileWriteEffectInput(
  runId: string,
  filePath: string,
  previousContent: string | null,
): SideEffectInput {
  return previousContent === null
    ? { runId, kind: 'file_create', description: `created ${filePath}`, reversal: { kind: 'delete_file', path: filePath } }
    : { runId, kind: 'file_modify', description: `modified ${filePath}`, reversal: { kind: 'restore_file', path: filePath, previousContent } };
}

/** Build the ledger input for a file delete; reversal restores the captured content. Pure. */
export function fileDeleteEffectInput(runId: string, filePath: string, previousContent: string): SideEffectInput {
  return { runId, kind: 'file_delete', description: `deleted ${filePath}`, reversal: { kind: 'restore_file', path: filePath, previousContent } };
}

/**
 * Write a file and record a reversible side effect. If the file existed, the
 * compensating action restores its prior content (kind file_modify); if it did
 * not, the compensating action deletes the created file (kind file_create). The
 * pre-image is captured BEFORE the write, which is the part the raw tools miss.
 */
export async function writeFileTracked(op: TrackedWriteOp): Promise<SideEffect> {
  const absPath = resolvePath(op.projectDir, op.filePath);
  const previous = await readIfExists(absPath);

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, op.content, 'utf-8');

  return recordSideEffect(op.projectDir, fileWriteEffectInput(op.runId, op.filePath, previous));
}

/**
 * Delete a file and record a reversible side effect that restores its content.
 * Returns null if the file did not exist (nothing happened, nothing to record).
 */
export async function deleteFileTracked(op: TrackedFileOp): Promise<SideEffect | null> {
  const absPath = resolvePath(op.projectDir, op.filePath);
  const previous = await readIfExists(absPath);
  if (previous === null) return null;

  await fs.unlink(absPath);

  return recordSideEffect(op.projectDir, fileDeleteEffectInput(op.runId, op.filePath, previous));
}
