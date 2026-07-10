import express from 'express';

import { getLatestSession } from '../persistence/resume';
import { SessionStorage } from '../persistence/sessionStorage';
import { buildWorkingMemory } from '../governed/workingMemory';
import type { ContinuityCheckpoint, SessionEvent } from '../types';

export interface WorkingMemoryRouterOptions {
  projectDir: string;
}

// Read-only surface for the Governed Agent Loop working memory: returns the
// latest session's most recent continuity checkpoint mapped into a unified
// WorkingMemory object. Never writes.
export function createWorkingMemoryRouter(opts: WorkingMemoryRouterOptions): express.Router {
  const router = express.Router();

  router.get('/api/working-memory', async (_req, res) => {
    try {
      const session = await getLatestSession(opts.projectDir);
      if (!session) { res.json({ workingMemory: null }); return; }
      const storage = new SessionStorage(opts.projectDir, session.model, session.sessionId);
      const events = await storage.readAll();
      const checkpoint = findLatestCheckpoint(events);
      if (!checkpoint) { res.json({ sessionId: session.sessionId, workingMemory: null }); return; }
      res.json({ sessionId: session.sessionId, workingMemory: buildWorkingMemory(checkpoint) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

function findLatestCheckpoint(events: SessionEvent[]): ContinuityCheckpoint | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i].data;
    if (data.kind === 'continuity_checkpoint') return data.checkpoint;
  }
  return null;
}
