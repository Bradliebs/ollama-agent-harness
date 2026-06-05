// Express router for repo-map cache + prompt-injection scan/sanitize.
//
// Extracted from server.ts as slice 7 of audit Fix #7. Both surfaces are
// projectDir-only and used exclusively by the HTTP layer, so server.ts
// drops both imports entirely after this extraction.

import express from 'express';
import { buildRepoMap, saveRepoMap, getOrBuildRepoMap } from '../core/repoMap';
import { scanForInjection, sanitizeMessage } from '../safety/injectionDefence';

export interface ScanRoutesDeps {
  projectDir: string;
}

export function createScanRouter(deps: ScanRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  // ─── Repo Map ──────────────────────────────────────────────────────

  /**
   * GET /api/repo-map
   * Return the cached repo map for projectDir. Builds one if absent or stale.
   * Query param: ?force=true  — always rebuild even if fresh.
   */
  router.get('/api/repo-map', async (req, res) => {
    try {
      const force = req.query.force === 'true';
      if (force) {
        const fresh = await buildRepoMap(projectDir);
        await saveRepoMap(fresh, projectDir);
        res.json(fresh);
      } else {
        const map = await getOrBuildRepoMap(projectDir);
        res.json(map);
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * POST /api/repo-map/scan
   * Force a full re-scan of projectDir (or a supplied `root` path) and save.
   * Body: { root?: string }
   * Returns: RepoMap
   */
  router.post('/api/repo-map/scan', async (req, res) => {
    try {
      const root = typeof req.body?.root === 'string' ? req.body.root : projectDir;
      const map = await buildRepoMap(root);
      await saveRepoMap(map, root);
      res.json(map);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ─── Injection Defence ────────────────────────────────────────────

  /**
   * POST /api/injection/scan
   * Scan a message for prompt injection patterns.
   * Body: { message: string, mode?: "flag" | "block", blockThreshold?: number }
   * Returns: InjectionScanResult
   */
  router.post('/api/injection/scan', (req, res) => {
    try {
      const { message, mode, blockThreshold } = req.body ?? {};
      if (typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ error: 'message is required.' });
        return;
      }
      const result = scanForInjection(message, {
        mode: mode ?? 'flag',
        blockThreshold: typeof blockThreshold === 'number' ? blockThreshold : undefined,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * POST /api/injection/sanitize
   * Strip known injection markers from a message.
   * Body: { message: string }
   * Returns: { sanitized: string }
   */
  router.post('/api/injection/sanitize', (req, res) => {
    try {
      const { message } = req.body ?? {};
      if (typeof message !== 'string') {
        res.status(400).json({ error: 'message is required.' });
        return;
      }
      res.json({ sanitized: sanitizeMessage(message) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
