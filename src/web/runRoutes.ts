// Express router for run logs (/api/run-logs; /api/runs is the existing chat/automation
// run history): list runs, inspect one run's events and side effects, and roll a run's
// file changes back to the end of a step.

import express from 'express';
import { listRuns, readRunEvents, summarizeRun, type RunEventKind } from '../persistence/runLog';
import { listSideEffects } from '../persistence/sideEffectLedger';
import { revertRun, revertToStep } from '../persistence/runReverter';
import { restoreGitCheckpoint } from '../persistence/gitCheckpoint';

export interface RunRoutesDeps {
  projectDir: string;
  /** Returns true if the request is authorised; sends 401 and returns false otherwise. */
  requireAuth: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
  logger: { info: (component: string, message: string, meta?: Record<string, unknown>) => void };
}

const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,160}$/;
const KNOWN_KINDS = new Set<RunEventKind>(['run_start', 'messages', 'compaction', 'model_request', 'model_response', 'model_error', 'tool_call', 'tool_result', 'route', 'verdict', 'supervisor', 'run_end']);

export function createRunRouter(deps: RunRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, requireAuth, logger } = deps;

  router.get('/api/run-logs', async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
      res.json({ runs: await listRuns(projectDir, limit) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/run-logs/:runId', async (req, res) => {
    const runId = String(req.params.runId);
    if (!SAFE_RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid run id.' }); return; }
    try {
      const events = await readRunEvents(projectDir, runId);
      if (events.length === 0) { res.status(404).json({ error: 'Run not found.' }); return; }
      const kinds = typeof req.query.kinds === 'string'
        ? new Set(req.query.kinds.split(',').map((kind) => kind.trim()).filter((kind): kind is RunEventKind => KNOWN_KINDS.has(kind as RunEventKind)))
        : null;
      const effects = await listSideEffects(projectDir, runId);
      res.json({
        summary: summarizeRun(runId, events),
        events: kinds ? events.filter((event) => kinds.has(event.kind)) : events,
        sideEffects: effects.map((effect) => ({ ...effect, reversal: effect.reversal.kind === 'restore_file' ? { kind: 'restore_file', path: effect.reversal.path } : effect.reversal })),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/run-logs/:runId/revert', async (req, res) => {
    const runId = String(req.params.runId);
    if (!SAFE_RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid run id.' }); return; }
    if (!requireAuth(req, res, 'run revert')) return;
    if (req.body?.mode === 'git') {
      try {
        const restored = await restoreGitCheckpoint(projectDir, runId);
        logger.info('Runs', 'Run restored from git checkpoint', { runId, removed: restored.removed.length });
        res.json({ runId, mode: 'git', commit: restored.commit, removed: restored.removed });
      } catch (error) {
        res.status(404).json({ error: `No git checkpoint for this run: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    const rawStep = req.body?.toStepSeq;
    if (rawStep !== undefined && (!Number.isInteger(rawStep) || rawStep < 0)) {
      res.status(400).json({ error: 'toStepSeq must be a non-negative integer.' });
      return;
    }
    try {
      const result = rawStep === undefined ? await revertRun(projectDir, runId) : await revertToStep(projectDir, runId, rawStep);
      logger.info('Runs', 'Run reverted', { runId, toStepSeq: rawStep ?? null, reverted: result.reverted.length, failed: result.failed.length });
      res.json({
        runId,
        toStepSeq: rawStep ?? null,
        reverted: result.reverted.map((effect) => effect.description),
        failed: result.failed.map((entry) => ({ description: entry.effect.description, error: entry.error })),
        irreversible: result.irreversible.map((effect) => effect.description),
        alreadyReversed: result.alreadyReversed.length,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
