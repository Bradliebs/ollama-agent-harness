// Dispatcher-boundary side-effect recording.
//
// File-mutating tools (file_write, file_edit, file_delete) perform their own
// fs.writeFile/unlink and capture no pre-image, so nothing they do can be undone.
// Rather than change the Tool.execute contract or every tool, the dispatcher —
// the single choke point all tool calls pass through — captures the pre-image
// BEFORE the tool runs and records a reversible side effect AFTER it succeeds.
//
// This is record-only (the tool does the write); recordingFileOps is the
// write+record primitive for internal callers. Both share the reversal builders.

import * as fs from 'fs/promises';
import * as path from 'path';
import { recordSideEffect, type SideEffectInput } from './sideEffectLedger';
import { readIfExists, fileWriteEffectInput, fileDeleteEffectInput } from './recordingFileOps';

export interface RecorderStep {
  stepId: string;
  stepSeq: number;
}

export interface SideEffectRecorder {
  projectDir: string;
  /** Groups every effect of this run so the run reverts as a unit. */
  runId: string;
  /**
   * Resolves the absolute path a tool will really touch (tools apply their own
   * redirects). Defaults to joining the raw path onto projectDir.
   */
  resolveTarget?: (toolName: string, rawPath: string) => string | null;
  /** Current run-log step for a call, so effects can be rolled back per step. */
  stepFor?: (toolName: string, input: Record<string, unknown>) => RecorderStep | undefined;
}

interface FileMutation {
  kind: 'write' | 'delete';
  path: string;
}

/** Pre-images above this size are not stored; the effect is recorded as irreversible. */
export const MAX_PREIMAGE_BYTES = 2 * 1024 * 1024;

interface NotificationSend {
  /** Channel the notification went out on, for the ledger description. */
  channel: string;
  /** One-line headline drawn from the call's title/body. */
  headline: string;
}

// file_edit also reduces to a write: it only ever modifies an existing file, and
// the reversal needs the pre-image, not the new content.
const WRITE_TOOLS = new Set(['file_write', 'file_edit']);
const DELETE_TOOLS = new Set(['file_delete']);

// Outbound notification tools, mapped to a human channel label. Both take
// { title, body } and perform an irreversible send.
const NOTIFY_TOOLS = new Map<string, string>([
  ['slack_notify', 'Slack'],
  ['telegram_notify', 'Telegram'],
]);

/**
 * Classify a tool call as a single-path file mutation, or null if it is not one
 * this slice records. Pure. file_move / document_export are intentionally not
 * handled here (move produces two compensating effects; deferred).
 */
export function describeFileMutation(toolName: string, input: Record<string, unknown>): FileMutation | null {
  const p = input?.path;
  if (typeof p !== 'string' || p.length === 0) return null;
  if (WRITE_TOOLS.has(toolName)) return { kind: 'write', path: p };
  if (DELETE_TOOLS.has(toolName)) return { kind: 'delete', path: p };
  return null;
}

/**
 * Classify a tool call as an outbound notification, or null if it is not one.
 * Pure. The headline is the title (falling back to the body) so the ledger
 * description names what was sent without storing the full payload.
 */
export function describeNotification(toolName: string, input: Record<string, unknown>): NotificationSend | null {
  const channel = NOTIFY_TOOLS.get(toolName);
  if (!channel) return null;
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  const headline = title || body || '(no content)';
  return { channel, headline };
}

/**
 * Capture the pre-image for a file-mutating tool call (or classify an outbound
 * notification) and return a `commit` closure to invoke after the tool succeeds,
 * which records the side effect — reversible for file mutations, irreversible
 * for notifications. Returns null when the call is neither, or when a delete
 * targets an absent file (nothing happens, nothing to record). Throwing here is
 * the caller's signal to skip recording; it must never block the tool.
 */
function resolveTargetPath(recorder: SideEffectRecorder, toolName: string, rawPath: string): string | null {
  if (recorder.resolveTarget) return recorder.resolveTarget(toolName, rawPath);
  return path.isAbsolute(rawPath) ? rawPath : path.join(recorder.projectDir, rawPath);
}

/** Pre-image that is too large to keep, as opposed to an absent file (null). */
const TOO_LARGE = Symbol('too-large');

async function readPreImage(absPath: string): Promise<string | null | typeof TOO_LARGE> {
  try {
    const stat = await fs.stat(absPath);
    if (stat.size > MAX_PREIMAGE_BYTES) return TOO_LARGE;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return readIfExists(absPath);
}

function tooLargeEffect(runId: string, kind: SideEffectInput['kind'], absPath: string): SideEffectInput {
  return { runId, kind, description: `changed ${absPath} (too large to snapshot)`, reversal: { kind: 'irreversible', reason: `pre-image over ${MAX_PREIMAGE_BYTES} bytes was not stored` } };
}

export async function prepareSideEffectRecording(
  recorder: SideEffectRecorder,
  toolName: string,
  input: Record<string, unknown>,
): Promise<(() => Promise<void>) | null> {
  const step = recorder.stepFor?.(toolName, input);
  const withStep = (effect: SideEffectInput): SideEffectInput => (step ? { ...effect, stepId: step.stepId, stepSeq: step.stepSeq } : effect);

  const mutation = describeFileMutation(toolName, input);
  if (mutation) {
    const absPath = resolveTargetPath(recorder, toolName, mutation.path);
    if (!absPath) return null;
    const previous = await readPreImage(absPath);
    if (mutation.kind === 'delete' && previous === null) return null;

    return async () => {
      const effect = previous === TOO_LARGE
        ? tooLargeEffect(recorder.runId, mutation.kind === 'delete' ? 'file_delete' : 'file_modify', absPath)
        : mutation.kind === 'delete'
          ? fileDeleteEffectInput(recorder.runId, absPath, previous as string)
          : fileWriteEffectInput(recorder.runId, absPath, previous);
      await recordSideEffect(recorder.projectDir, withStep(effect));
    };
  }

  // A move is two compensations: the destination is created (or overwritten)
  // and the source disappears. Recording destination first means the reverse-
  // order undo restores the source before removing the destination.
  if (toolName === 'file_move' && typeof input?.from === 'string' && typeof input?.to === 'string') {
    const fromPath = resolveTargetPath(recorder, toolName, input.from);
    const toPath = resolveTargetPath(recorder, toolName, input.to);
    if (!fromPath || !toPath) return null;
    const fromPrevious = await readPreImage(fromPath);
    if (fromPrevious === null) return null;
    const toPrevious = await readPreImage(toPath);
    return async () => {
      const destination = toPrevious === TOO_LARGE
        ? tooLargeEffect(recorder.runId, 'file_modify', toPath)
        : fileWriteEffectInput(recorder.runId, toPath, toPrevious);
      const source = fromPrevious === TOO_LARGE
        ? tooLargeEffect(recorder.runId, 'file_delete', fromPath)
        : fileDeleteEffectInput(recorder.runId, fromPath, fromPrevious);
      await recordSideEffect(recorder.projectDir, withStep(destination));
      await recordSideEffect(recorder.projectDir, withStep(source));
    };
  }

  // Notifications have no pre-image and cannot be unsent: record an irreversible
  // effect only AFTER the send succeeds (commit runs post-success), so a failed
  // send never leaves a phantom "notification sent" entry in the ledger.
  const notification = describeNotification(toolName, input);
  if (notification) {
    return async () => {
      await recordSideEffect(recorder.projectDir, withStep({
        runId: recorder.runId,
        kind: 'notification',
        description: `sent ${notification.channel} notification: ${notification.headline}`,
        reversal: { kind: 'irreversible', reason: `${notification.channel} notification cannot be unsent` },
      }));
    };
  }

  return null;
}
