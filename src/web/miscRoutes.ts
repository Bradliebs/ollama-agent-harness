import express from 'express';
import { classifyMode } from '../services/modeClassifier';
import { WorkerQueue } from '../services/workerQueue';
import { getSwallowedFailureCount, getSwallowedFailures } from '../observability/silentFailureSink';

export interface MiscRoutesDeps {
  // No external deps — workerQueue is an HTTP-local singleton.
}

export function createMiscRouter(_deps: MiscRoutesDeps = {}): express.Router {
  const router = express.Router();
  const workerQueue = new WorkerQueue();

  router.get('/api/worker/status', (_req, res) => {
    res.json({ pending: workerQueue.pendingCount(), queue: workerQueue.pending(), history: workerQueue.history() });
  });

  router.get('/api/modes/classify', (req, res) => {
    const message = typeof req.query.message === 'string' ? req.query.message : '';
    if (!message) { res.status(400).json({ error: 'message query parameter is required' }); return; }
    res.json(classifyMode(message));
  });

  // Diagnostics: the silent-failure sink — every error that was caught and
  // recorded since process start. Bounded at 200 entries; oldest evicted first.
  router.get('/api/diagnostics/swallowed', (_req, res) => {
    res.json({
      count: getSwallowedFailureCount(),
      failures: getSwallowedFailures(),
    });
  });

  return router;
}
