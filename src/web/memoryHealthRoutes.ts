// Express router for memory conflict detection + staleness scanning.
//
// Extracted from server.ts as slice 6 of audit Fix #7. Both routes only
// depend on projectDir. server.ts dropped the memoryConflictDetector
// import entirely after this extraction.

import express from 'express';
import {
  scanFileForConflicts,
  findStaleEntries,
  findAllStaleEntries,
} from '../services/memoryConflictDetector';

export interface MemoryHealthRoutesDeps {
  projectDir: string;
}

export function createMemoryHealthRouter(deps: MemoryHealthRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  /**
   * POST /api/memory/conflicts
   * Check a candidate memory entry for conflicts against an existing file.
   * Body: { fileName: string, body: string }
   * Returns: { conflicts: ConflictResult[] }
   */
  router.post('/api/memory/conflicts', async (req, res) => {
    try {
      const { fileName, body } = req.body ?? {};
      if (typeof fileName !== 'string' || !fileName.trim()) {
        res.status(400).json({ error: 'fileName is required (e.g. "patterns.md")' });
        return;
      }
      if (typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const conflicts = await scanFileForConflicts(projectDir, fileName, body);
      res.json({ conflicts });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * GET /api/memory/stale
   * Return stale memory sections across all (or a specific) memory file.
   * Query param: ?file=patterns.md  — scope to one file; omit for all files.
   * Returns: { stale: Record<string, StalenessResult[]> } or { stale: StalenessResult[] }
   */
  router.get('/api/memory/stale', async (req, res) => {
    try {
      const file = typeof req.query.file === 'string' ? req.query.file : undefined;
      if (file) {
        const stale = await findStaleEntries(projectDir, file);
        res.json({ stale });
      } else {
        const stale = await findAllStaleEntries(projectDir);
        res.json({ stale });
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
