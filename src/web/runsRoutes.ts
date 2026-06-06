import express from 'express';
import { SessionStorage } from '../persistence/sessionStorage';
import { readRunEvidence } from '../persistence/evidenceStore';

export interface RunsRoutesDeps {
  projectDir: string;
}

export function createRunsRouter(deps: RunsRoutesDeps): express.Router {
  const { projectDir } = deps;
  const router = express.Router();

  // Same source as /api/sessions but enriched with derived fields
  // (duration, age) the dashboard renders without per-row computation.
  router.get('/api/runs', async (_req, res) => {
    try {
      const sessions = await SessionStorage.listSessions(projectDir);
      const evidence = await readRunEvidence(projectDir, 200);
      const now = Date.now();
      const runs = sessions.map((session) => {
        const startMs = Date.parse(session.createdAt);
        const endMs = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
        const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
        const ageMs = Number.isFinite(startMs) ? Math.max(0, now - startMs) : null;
        return {
          sessionId: session.sessionId,
          title: session.title || 'Untitled run',
          model: session.model,
          status: session.status || 'unknown',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          durationMs,
          ageMs,
          checkpointCount: session.checkpointCount ?? 0,
          lastError: session.lastError,
          parentSessionId: session.parentSessionId,
        };
      });
      const counts: Record<string, number> = {};
      for (const run of runs) counts[run.status] = (counts[run.status] ?? 0) + 1;
      res.json({ runs, total: runs.length, counts, evidence });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
