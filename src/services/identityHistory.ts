// Identity history layer.
//
// Captures point-in-time snapshots of SOUL.md / USER.md / structured.json
// to `.harness/identity/history/<id>/` so any future identity edit
// (manual or agent-driven) can be diffed and reverted. Strictly additive:
// nothing here mutates the live identity files except restoreIdentityFromHistory,
// and that always captures the current state first.

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  readIdentitySnapshot,
  writeIdentityFile,
  type IdentitySnapshot,
} from './identity';

export interface IdentitySnapshotMeta {
  id: string;
  capturedAt: string;
  reason: string;
}

export interface IdentitySnapshotRecord extends IdentitySnapshotMeta {
  snapshot: IdentitySnapshot;
}

function historyDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'identity', 'history');
}

function snapshotDir(projectDir: string, id: string): string {
  return path.join(historyDir(projectDir), id);
}

function slugifyReason(reason: string): string {
  const cleaned = reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 40) || 'manual';
}

function formatTimestampForId(date: Date): string {
  // ISO with ':' / '.' replaced so it's safe as a directory name on Windows.
  return date.toISOString().replace(/[:.]/g, '-');
}

function buildSnapshotId(reason: string, now: Date): string {
  return `${formatTimestampForId(now)}-${slugifyReason(reason)}`;
}

/**
 * Capture the current SOUL.md / USER.md / structured.json into a new
 * history directory. Returns the snapshot's id. Never overwrites an
 * existing snapshot — if a collision occurs (same millisecond + reason),
 * a numeric suffix is appended.
 */
export async function captureIdentitySnapshot(
  projectDir: string,
  reason: string,
  now: Date = new Date(),
): Promise<IdentitySnapshotMeta> {
  const snapshot = await readIdentitySnapshot(projectDir);
  const baseId = buildSnapshotId(reason, now);
  let id = baseId;
  let suffix = 1;
  while (await directoryExists(snapshotDir(projectDir, id))) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  const dir = snapshotDir(projectDir, id);
  await fs.mkdir(dir, { recursive: true });
  const meta: IdentitySnapshotMeta = { id, capturedAt: now.toISOString(), reason };
  await Promise.all([
    fs.writeFile(path.join(dir, 'SOUL.md'), snapshot.soul, 'utf-8'),
    fs.writeFile(path.join(dir, 'USER.md'), snapshot.user, 'utf-8'),
    fs.writeFile(path.join(dir, 'structured.json'), JSON.stringify(snapshot.structured, null, 2), 'utf-8'),
    fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8'),
  ]);
  return meta;
}

export async function listIdentityHistory(projectDir: string): Promise<IdentitySnapshotMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(historyDir(projectDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const metas: IdentitySnapshotMeta[] = [];
  for (const name of entries) {
    const metaPath = path.join(snapshotDir(projectDir, name), 'meta.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IdentitySnapshotMeta>;
      if (typeof parsed.id === 'string' && typeof parsed.capturedAt === 'string' && typeof parsed.reason === 'string') {
        metas.push({ id: parsed.id, capturedAt: parsed.capturedAt, reason: parsed.reason });
      }
    } catch {
      // Skip unreadable entries; the caller can prune them via the file system if desired.
    }
  }
  // Most recent first.
  metas.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return metas;
}

export async function loadIdentityHistory(projectDir: string, id: string): Promise<IdentitySnapshotRecord | null> {
  const dir = snapshotDir(projectDir, id);
  if (!(await directoryExists(dir))) return null;
  try {
    const [metaRaw, soul, user, structuredRaw] = await Promise.all([
      fs.readFile(path.join(dir, 'meta.json'), 'utf-8'),
      fs.readFile(path.join(dir, 'SOUL.md'), 'utf-8'),
      fs.readFile(path.join(dir, 'USER.md'), 'utf-8'),
      fs.readFile(path.join(dir, 'structured.json'), 'utf-8'),
    ]);
    const meta = JSON.parse(metaRaw) as IdentitySnapshotMeta;
    const structured = JSON.parse(structuredRaw) as IdentitySnapshot['structured'];
    return { ...meta, snapshot: { soul, user, structured } };
  } catch {
    return null;
  }
}

/**
 * Restore a historical snapshot into the live identity files. Always
 * captures the current state first under reason="pre-restore-<id>" so the
 * restore is itself reversible.
 */
export async function restoreIdentityFromHistory(
  projectDir: string,
  id: string,
  now: Date = new Date(),
): Promise<{ restored: IdentitySnapshotMeta; backup: IdentitySnapshotMeta } | null> {
  const target = await loadIdentityHistory(projectDir, id);
  if (!target) return null;
  const backup = await captureIdentitySnapshot(projectDir, `pre-restore-${id}`, now);
  await writeIdentityFile(projectDir, 'SOUL.md', target.snapshot.soul);
  await writeIdentityFile(projectDir, 'USER.md', target.snapshot.user);
  const structuredPath = path.join(projectDir, '.harness', 'identity', 'structured.json');
  await fs.writeFile(structuredPath, JSON.stringify(target.snapshot.structured, null, 2), 'utf-8');
  return { restored: { id: target.id, capturedAt: target.capturedAt, reason: target.reason }, backup };
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
