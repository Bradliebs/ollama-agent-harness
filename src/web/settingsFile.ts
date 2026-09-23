// Atomic settings.json writer, extracted from server.ts.
//
// Merges with fields already on disk (so a running server never clobbers
// fields it does not manage), refuses to write invalid JSON, writes to a temp
// file, then renames with retries for transient Windows sharing violations.

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';

export const SETTINGS_SAVE_RETRY_DELAYS_MS = [25, 75, 150, 300, 600];

export function isTransientSettingsRenameError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SettingsFileOps {
  rename: (from: string, to: string) => Promise<void>;
  platform: NodeJS.Platform;
  retryDelaysMs: number[];
}

const defaultOps: SettingsFileOps = {
  rename: (from, to) => fs.rename(from, to),
  platform: process.platform,
  retryDelaysMs: SETTINGS_SAVE_RETRY_DELAYS_MS,
};

export async function renameSettingsFileWithRetry(tmpPath: string, targetPath: string, ops: SettingsFileOps = defaultOps): Promise<void> {
  for (let attempt = 0; attempt <= ops.retryDelaysMs.length; attempt += 1) {
    try {
      await ops.rename(tmpPath, targetPath);
      return;
    } catch (error) {
      if (!isTransientSettingsRenameError(error, ops.platform) || attempt === ops.retryDelaysMs.length) throw error;
      const code = (error as NodeJS.ErrnoException).code || 'unknown';
      logger.warn('Settings', 'Retrying settings save after transient rename failure', { code, attempt: attempt + 1 });
      await delay(ops.retryDelaysMs[attempt]);
    }
  }
}

/**
 * Write settings to `settingsPath`, merged over whatever is already there.
 * Returns false (and writes nothing) if the merged result is not valid JSON.
 */
export async function writeSettingsFile(settingsPath: string, settings: Record<string, unknown>, ops: SettingsFileOps = defaultOps): Promise<boolean> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  let merged: Record<string, unknown> = settings;
  try {
    const existing = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
    merged = { ...existing, ...settings };
  } catch { /* file missing or invalid — use settings as-is */ }
  const json = JSON.stringify(merged, null, 2);
  try {
    JSON.parse(json);
  } catch {
    logger.warn('Settings', 'Skipped save: serialized JSON is invalid');
    return false;
  }
  const tmpPath = `${settingsPath}.tmp`;
  await fs.writeFile(tmpPath, json, 'utf-8');
  await renameSettingsFileWithRetry(tmpPath, settingsPath, ops);
  return true;
}
