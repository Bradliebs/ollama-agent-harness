import express from 'express';

import { readBrowserAudit } from '../tools/browserAudit';
import {
  listBrowserSessions,
  saveBrowserSession,
  deleteBrowserSession,
} from '../tools/browserSessions';
import { captureBrowserStorageState } from '../tools/browserTools';

// Read/manage surface for the browser hardening features:
//   * GET    /api/browser/audit            recent page-action audit entries
//   * GET    /api/browser/sessions         saved cookie/session vault entries (metadata only)
//   * POST   /api/browser/sessions/:name   capture the live browser login into a named vault entry
//   * DELETE /api/browser/sessions/:name   remove a vault entry
//
// Redaction settings live in the main settings store (POST /api/settings,
// field `browserRedaction`) and are applied at write time inside
// browserAudit, so they are intentionally NOT duplicated here.
export function createBrowserHardeningRouter(): express.Router {
  const router = express.Router();

  router.get('/api/browser/audit', async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 200;
      const entries = await readBrowserAudit(limit);
      res.json({ entries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/browser/sessions', async (_req, res) => {
    try {
      const sessions = await listBrowserSessions();
      res.json({ sessions });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/browser/sessions/:name', async (req, res) => {
    try {
      const name = String(req.params.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'A session name is required.' });
        return;
      }
      const state = await captureBrowserStorageState();
      if (!state) {
        res.status(409).json({ error: 'No live browser session to save. Open a page first (browser_navigate).' });
        return;
      }
      const meta = await saveBrowserSession(name, state);
      res.json({ ok: true, session: meta });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/browser/sessions/:name', async (req, res) => {
    try {
      const name = String(req.params.name ?? '').trim();
      const removed = await deleteBrowserSession(name);
      if (!removed) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
