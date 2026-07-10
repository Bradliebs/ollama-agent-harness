// Express router for the Promise Ledger surface.
//
// Extracted from server.ts as the third slice of audit Fix #7 (route-block
// extraction). Pattern matches goalRoutes / identityRoutes / taskRoutes:
// projectDir is the only dependency the handlers actually need; emitEvent
// failures are funnelled through the same recordSwallowed sink the rest of
// the codebase uses (we accept the injected callback so the router doesn't
// reach into observability state on its own).

import express from 'express';
import {
  createPromise,
  listPromises,
  updatePromise,
  checkObligations,
  fulfilPromise,
  failPromise,
  type PromiseStatus,
} from '../services/promiseLedger';
import { emitEvent } from '../persistence/eventStore';

export interface PromiseRoutesDeps {
  projectDir: string;
  /** Used to swallow + record emitEvent failures without breaking the response. */
  recordSwallowed: (component: string, err: unknown) => void;
}

export function createPromiseRouter(deps: PromiseRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, recordSwallowed } = deps;

  router.get('/api/promises', async (req, res) => {
    try {
      const status = req.query.status as PromiseStatus | undefined;
      const service_id = typeof req.query.service_id === 'string' ? req.query.service_id : undefined;
      const promises = await listPromises(projectDir, { status, service_id });
      res.json({ total: promises.length, promises });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/promises', async (req, res) => {
    try {
      const { commitment, service_id, schedule_id, capability_required, next_due_at, fallback_message, session_id } = req.body ?? {};
      if (!commitment || typeof commitment !== 'string') { res.status(400).json({ error: 'commitment is required.' }); return; }
      const promise = await createPromise(projectDir, commitment, { service_id, schedule_id, capability_required, next_due_at, fallback_message, session_id });
      await emitEvent(projectDir, 'promise', 'promise_created', { promise_id: promise.promise_id, commitment }, 'user', promise.promise_id).catch((err) => recordSwallowed('emitEvent', err));
      res.json(promise);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/promises/:id/fulfil', async (req, res) => {
    try {
      const promiseId = req.params.id;
      const result = await fulfilPromise(projectDir, promiseId);
      if (!result) { res.status(404).json({ error: 'Promise not found.' }); return; }
      await emitEvent(projectDir, 'promise', 'promise_fulfilled', { promise_id: promiseId }, 'system', promiseId).catch((err) => recordSwallowed('emitEvent', err));
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/promises/:id/fail', async (req, res) => {
    try {
      const promiseId = req.params.id;
      const markFailed = req.body?.markFailed === true;
      const result = await failPromise(projectDir, promiseId, markFailed);
      if (!result) { res.status(404).json({ error: 'Promise not found.' }); return; }
      await emitEvent(projectDir, 'promise', 'promise_failed', { promise_id: promiseId, markFailed }, 'system', promiseId).catch((err) => recordSwallowed('emitEvent', err));
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/promises/obligations', async (_req, res) => {
    try {
      const result = await checkObligations(projectDir);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/promises/:id/cancel', async (req, res) => {
    try {
      const promiseId = req.params.id;
      const result = await updatePromise(projectDir, promiseId, { status: 'cancelled' });
      if (!result) { res.status(404).json({ error: 'Promise not found.' }); return; }
      await emitEvent(projectDir, 'promise', 'promise_cancelled', { promise_id: promiseId }, 'user', promiseId).catch((err) => recordSwallowed('emitEvent', err));
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
