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

import * as path from 'path';
import { recordSideEffect } from './sideEffectLedger';
import { readIfExists, fileWriteEffectInput, fileDeleteEffectInput } from './recordingFileOps';

export interface SideEffectRecorder {
  projectDir: string;
  /** Groups every effect of this run so the run reverts as a unit. */
  runId: string;
}

interface FileMutation {
  kind: 'write' | 'delete';
  path: string;
}

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
export async function prepareSideEffectRecording(
  recorder: SideEffectRecorder,
  toolName: string,
  input: Record<string, unknown>,
): Promise<(() => Promise<void>) | null> {
  const mutation = describeFileMutation(toolName, input);
  if (mutation) {
    const absPath = path.isAbsolute(mutation.path) ? mutation.path : path.join(recorder.projectDir, mutation.path);
    const previous = await readIfExists(absPath);
    if (mutation.kind === 'delete' && previous === null) return null;

    return async () => {
      const effect =
        mutation.kind === 'delete'
          ? fileDeleteEffectInput(recorder.runId, mutation.path, previous as string)
          : fileWriteEffectInput(recorder.runId, mutation.path, previous);
      await recordSideEffect(recorder.projectDir, effect);
    };
  }

  // Notifications have no pre-image and cannot be unsent: record an irreversible
  // effect only AFTER the send succeeds (commit runs post-success), so a failed
  // send never leaves a phantom "notification sent" entry in the ledger.
  const notification = describeNotification(toolName, input);
  if (notification) {
    return async () => {
      await recordSideEffect(recorder.projectDir, {
        runId: recorder.runId,
        kind: 'notification',
        description: `sent ${notification.channel} notification: ${notification.headline}`,
        reversal: { kind: 'irreversible', reason: `${notification.channel} notification cannot be unsent` },
      });
    };
  }

  return null;
}
