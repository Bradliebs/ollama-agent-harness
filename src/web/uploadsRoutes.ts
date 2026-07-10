import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';

export interface UploadsCleanupResult {
  removed: Array<{ name: string; size: number; modified: string }>;
  removedBytes: number;
  olderThanDays: number;
  lastPrunedAt: string;
}

export interface UploadsRoutesDeps {
  getUploadsDir: () => string;
  pruneUploads: (olderThanDays: number) => Promise<UploadsCleanupResult>;
}

function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && /^[a-zA-Z0-9._-]+$/.test(id) ? id : null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function createUploadsRouter(deps: UploadsRoutesDeps): express.Router {
  const { getUploadsDir, pruneUploads } = deps;
  const router = express.Router();

  router.get('/api/uploads', async (_req, res) => {
    const uploadsDir = getUploadsDir();
    try {
      await fs.mkdir(uploadsDir, { recursive: true });
      const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
      const files = [];
      let totalBytes = 0;
      let oldestMs: number | null = null;
      for (const e of entries.filter(e => e.isFile())) {
        const stat = await fs.stat(path.join(uploadsDir, e.name));
        const mtime = stat.mtime.getTime();
        totalBytes += stat.size;
        if (oldestMs === null || mtime < oldestMs) oldestMs = mtime;
        files.push({ name: e.name, path: path.join(uploadsDir, e.name), size: stat.size, modified: stat.mtime.toISOString() });
      }
      res.json({
        files,
        directory: uploadsDir,
        totalBytes,
        oldest: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
      });
    } catch { res.json({ files: [], directory: uploadsDir, totalBytes: 0, oldest: null }); }
  });

  router.delete('/api/uploads/:name', async (req, res) => {
    const safe = safeLocalId(path.basename(req.params.name));
    if (!safe) { res.status(400).json({ error: 'Invalid upload name.' }); return; }
    try {
      await fs.unlink(path.join(getUploadsDir(), safe));
      res.json({ ok: true });
    } catch { res.status(404).json({ error: 'Not found' }); }
  });

  router.post('/api/uploads/cleanup', async (req, res) => {
    const days = clampNumber(req.body?.olderThanDays, 0, 3650, 30);
    if (days <= 0) {
      res.status(400).json({ error: 'olderThanDays must be greater than 0 for manual cleanup.' });
      return;
    }
    try {
      const result = await pruneUploads(days);
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
