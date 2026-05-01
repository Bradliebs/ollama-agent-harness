// Lightweight snapshot system for ~/.harness/skills, MEMORY.md, and config.
//
// Stores point-in-time copies as gzipped tarballs under
// `<projectDir>/.harness/snapshots/<id>.tar.gz`, with metadata sidecars at
// `<id>.meta.json`.  No external deps; uses Node's built-in tar-from-scratch
// is overkill for a tiny tree, so we serialize the targeted files as a
// single JSON document instead.  The trade-off is intentional:
//
//   * keeps `package.json` deps unchanged (no `tar`, no `simple-git`)
//   * works identically on Windows and POSIX (no shell-out, no git binary)
//   * snapshots are small (KB-scale) because we only track tiny text trees
//
// Tracked paths (relative to the project dir):
//   * .harness/skills/**
//   * .harness/MEMORY.md
//   * .harness/USER.md (when present)
//   * .harness/SOUL.md (when present)
//
// Each snapshot is reversible — `restore(id)` first takes a safety snapshot
// so the user can always undo a bad restore.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const TRACKED_PATHS = [
  '.harness/skills',
  '.harness/MEMORY.md',
  '.harness/USER.md',
  '.harness/SOUL.md',
];

interface SnapshotFile {
  /** Path relative to the project dir, with forward slashes. */
  path: string;
  /** UTF-8 file content. Binary files are out of scope (text-only project). */
  content: string;
  sha1: string;
}

interface SnapshotPayload {
  version: 1;
  files: SnapshotFile[];
}

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  reason: string;
  fileCount: number;
  totalBytes: number;
  /** Filled by `list()`; absent on the meta JSON to keep it small. */
  payloadPath?: string;
}

export interface SnapshotDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

function snapshotsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'snapshots');
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function walkText(absRoot: string, projectDir: string): Promise<SnapshotFile[]> {
  const out: SnapshotFile[] = [];
  let stat;
  try { stat = await fs.stat(absRoot); } catch { return out; }
  if (stat.isFile()) {
    const content = await fs.readFile(absRoot, 'utf-8');
    out.push({
      path: relPosix(projectDir, absRoot),
      content,
      sha1: sha1(content),
    });
    return out;
  }
  if (!stat.isDirectory()) return out;
  const entries = await fs.readdir(absRoot, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(absRoot, entry.name);
    out.push(...(await walkText(child, projectDir)));
  }
  return out;
}

function relPosix(projectDir: string, abs: string): string {
  const rel = path.relative(projectDir, abs);
  return rel.split(path.sep).join('/');
}

async function collectTrackedFiles(projectDir: string): Promise<SnapshotFile[]> {
  const out: SnapshotFile[] = [];
  for (const rel of TRACKED_PATHS) {
    const abs = path.join(projectDir, rel);
    if (!(await fileExists(abs))) continue;
    out.push(...(await walkText(abs, projectDir)));
  }
  // Deterministic order so two snapshots of the same tree produce identical payloads.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function take(projectDir: string, reason: string = 'manual'): Promise<SnapshotMeta> {
  const dir = snapshotsDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const files = await collectTrackedFiles(projectDir);
  const payload: SnapshotPayload = { version: 1, files };
  const id = `snap-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const payloadPath = path.join(dir, `${id}.json`);
  const metaPath = path.join(dir, `${id}.meta.json`);
  const payloadJson = JSON.stringify(payload);
  await fs.writeFile(payloadPath, payloadJson, 'utf-8');
  const totalBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf-8'), 0);
  const meta: SnapshotMeta = {
    id,
    createdAt: new Date().toISOString(),
    reason: reason.slice(0, 200),
    fileCount: files.length,
    totalBytes,
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}

export async function list(projectDir: string): Promise<SnapshotMeta[]> {
  const dir = snapshotsDir(projectDir);
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return []; }
  const metas: SnapshotMeta[] = [];
  for (const file of entries) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const content = await fs.readFile(path.join(dir, file), 'utf-8');
      const meta = JSON.parse(content) as SnapshotMeta;
      meta.payloadPath = path.join(dir, `${meta.id}.json`);
      metas.push(meta);
    } catch {
      // Skip corrupt metas rather than failing the whole list.
    }
  }
  metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return metas;
}

export async function get(projectDir: string, id: string): Promise<SnapshotPayload | null> {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId) return null;
  const payloadPath = path.join(snapshotsDir(projectDir), `${safeId}.json`);
  try {
    const content = await fs.readFile(payloadPath, 'utf-8');
    return JSON.parse(content) as SnapshotPayload;
  } catch {
    return null;
  }
}

export async function diff(projectDir: string, id: string): Promise<SnapshotDiff | null> {
  const snap = await get(projectDir, id);
  if (!snap) return null;
  const current = await collectTrackedFiles(projectDir);
  const currentByPath = new Map(current.map((f) => [f.path, f]));
  const snapByPath = new Map(snap.files.map((f) => [f.path, f]));
  const out: SnapshotDiff = { added: [], modified: [], removed: [] };
  for (const cur of current) {
    const prev = snapByPath.get(cur.path);
    if (!prev) out.added.push(cur.path);
    else if (prev.sha1 !== cur.sha1) out.modified.push(cur.path);
  }
  for (const prev of snap.files) {
    if (!currentByPath.has(prev.path)) out.removed.push(prev.path);
  }
  out.added.sort();
  out.modified.sort();
  out.removed.sort();
  return out;
}

export async function restore(projectDir: string, id: string): Promise<{ restoredFiles: number; safetySnapshotId: string } | null> {
  const snap = await get(projectDir, id);
  if (!snap) return null;
  // Pre-restore safety snapshot so the restore itself is reversible.
  const safety = await take(projectDir, `pre-restore safety (target=${id})`);
  // Wipe each tracked root so files removed in the snapshot disappear cleanly.
  for (const rel of TRACKED_PATHS) {
    const abs = path.join(projectDir, rel);
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        await fs.rm(abs, { recursive: true, force: true });
      } else if (stat.isFile()) {
        await fs.rm(abs, { force: true });
      }
    } catch { /* missing is fine */ }
  }
  for (const file of snap.files) {
    const abs = path.join(projectDir, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, 'utf-8');
  }
  return { restoredFiles: snap.files.length, safetySnapshotId: safety.id };
}

export async function remove(projectDir: string, id: string): Promise<boolean> {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId) return false;
  const dir = snapshotsDir(projectDir);
  let removed = false;
  for (const file of [`${safeId}.json`, `${safeId}.meta.json`]) {
    try { await fs.rm(path.join(dir, file), { force: true }); removed = true; } catch { /* ignore */ }
  }
  return removed;
}
