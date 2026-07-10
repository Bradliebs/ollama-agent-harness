import express from 'express';
import * as snapshots from '../persistence/snapshots';

export interface SnapshotRoutesDeps {
  projectDir: string;
}

// Lightweight point-in-time copies of `.harness/skills`, MEMORY.md,
// USER.md, SOUL.md so users can roll back self-improvement edits or
// recover a tree they accidentally clobbered.
export function createSnapshotRouter(deps: SnapshotRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/snapshots', async (_req, res) => {
    try {
      res.json({ snapshots: await snapshots.list(projectDir) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/snapshots', async (req, res) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
      const meta = await snapshots.take(projectDir, reason);
      res.json({ snapshot: meta });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/snapshots/:id/diff', async (req, res) => {
    try {
      const diff = await snapshots.diff(projectDir, req.params.id);
      if (!diff) { res.status(404).json({ error: 'snapshot not found' }); return; }
      res.json(diff);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/snapshots/:id/restore', async (req, res) => {
    try {
      const result = await snapshots.restore(projectDir, req.params.id);
      if (!result) { res.status(404).json({ error: 'snapshot not found' }); return; }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/snapshots/:id', async (req, res) => {
    try {
      const ok = await snapshots.remove(projectDir, req.params.id);
      if (!ok) { res.status(404).json({ error: 'snapshot not found' }); return; }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
