// Express router for identity (SOUL.md / USER.md / structured facts).
//
// Extracted from server.ts as the first step of the audit's Fix #7 (route-block
// extraction from the 11k-line server). Pattern mirrors goalRoutes.ts:
// dependencies (projectDir + auth helpers + logger) are injected so the router
// has no closures over server.ts module-scoped state.

import express from 'express';
import {
  deleteStructuredEntry,
  exportIdentity,
  importIdentity,
  queryStructured,
  readIdentityFile,
  readIdentitySnapshot,
  upsertStructuredEntry,
  writeIdentityFile,
  type IdentityFileName,
} from '../services/identity';

export interface IdentityRoutesDeps {
  projectDir: string;
  /** Returns true if the request is authorised; should send 401 + return false otherwise. */
  requireAuth: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
  /**
   * Validates an audit reason on the request and returns the normalised string,
   * or null after sending 400. Same contract as server.ts's requireAuditReason.
   */
  requireAuditReason: (value: unknown, res: express.Response, actionLabel: string) => string | null;
  /** Logger surface for the one place identity code logs (overwrite import). */
  logger: { info: (component: string, message: string, meta?: Record<string, unknown>) => void };
}

const VALID_IDENTITY_FILES = new Set<IdentityFileName>(['SOUL.md', 'USER.md']);

export function createIdentityRouter(deps: IdentityRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, requireAuth, requireAuditReason, logger } = deps;

  router.get('/api/identity', async (_req, res) => {
    try {
      const snapshot = await readIdentitySnapshot(projectDir);
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/api/identity/:file', async (req, res) => {
    try {
      const fileName = req.params.file as IdentityFileName;
      if (!VALID_IDENTITY_FILES.has(fileName)) { res.status(400).json({ error: 'file must be SOUL.md or USER.md.' }); return; }
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      await writeIdentityFile(projectDir, fileName, content);
      const reread = await readIdentityFile(projectDir, fileName);
      res.json({ file: fileName, content: reread });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/identity/structured', async (req, res) => {
    try {
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const entries = await queryStructured(projectDir, { category, q });
      res.json({ entries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/identity/structured', async (req, res) => {
    try {
      const { id, category, summary, metadata } = req.body ?? {};
      if (typeof category !== 'string' || !category.trim()) { res.status(400).json({ error: 'category is required.' }); return; }
      if (typeof summary !== 'string' || !summary.trim()) { res.status(400).json({ error: 'summary is required.' }); return; }
      const entry = await upsertStructuredEntry(projectDir, {
        id: typeof id === 'string' ? id : undefined,
        category,
        summary,
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
      });
      res.json({ entry });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/identity/structured/:id', async (req, res) => {
    try {
      const removed = await deleteStructuredEntry(projectDir, req.params.id);
      if (!removed) { res.status(404).json({ error: 'Structured entry not found.' }); return; }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/identity/export', async (_req, res) => {
    try {
      const payload = await exportIdentity(projectDir);
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/identity/import', async (req, res) => {
    try {
      if (!requireAuth(req, res, 'identity import')) return;
      const mergeStructured = req.body?.mergeStructured !== false;
      const overwriteFiles = req.body?.overwriteFiles !== false;
      const hasOverwriteContent = overwriteFiles && (
        (typeof req.body?.snapshot?.soul === 'string' && req.body.snapshot.soul.trim().length > 0)
        || (typeof req.body?.snapshot?.user === 'string' && req.body.snapshot.user.trim().length > 0)
      );
      if (hasOverwriteContent) {
        const reason = requireAuditReason(req.body?.reason, res, 'Identity import with SOUL/USER overwrite');
        if (!reason) return;
        logger.info('Identity', 'Import requested with file overwrite', { reason, mergeStructured });
      }
      const summary = await importIdentity(projectDir, req.body, { mergeStructured, overwriteFiles });
      res.json({ summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  return router;
}
