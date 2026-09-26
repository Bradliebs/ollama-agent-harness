import express from 'express';
import { benchmarkHistory, compareRuns, loadReplayCase, replayRun, type BenchmarkHistoryReport, type ReplayComparisonReport } from '../eval/replay';
import type { IChatClient } from '../core/chatClient';
import type { Tool } from '../types';

export interface ReplayRoutesDeps {
  projectDir: string;
  requireAuth: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
  createClient: (model: string) => IChatClient | Promise<IChatClient>;
  /** Real tools lending schemas to deterministic replay stubs (never executed). */
  getSchemaTools?: () => Tool[];
  logger: { info: (component: string, message: string, meta?: Record<string, unknown>) => void };
}

type ReplayJobStatus = 'running' | 'completed' | 'failed';

type ReplayJob = {
  id: string;
  status: ReplayJobStatus;
  createdAt: string;
  updatedAt: string;
  request: { runId?: string; lastN?: number; models: string[] };
  report?: ReplayComparisonReport | BenchmarkHistoryReport;
  error?: string;
};

const jobs: ReplayJob[] = [];
const MAX_JOBS = 50;
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,160}$/;

export function createReplayRouter(deps: ReplayRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, requireAuth, createClient, logger } = deps;
  const schemaTools = (): Tool[] | undefined => deps.getSchemaTools?.();

  router.post('/api/replays', async (req, res) => {
    if (!requireAuth(req, res, 'replay run')) return;
    const body = (req.body ?? {}) as { runId?: unknown; lastN?: unknown; models?: unknown };
    const runId = typeof body.runId === 'string' ? body.runId.trim() : undefined;
    const lastN = Number(body.lastN ?? 0);
    const models = Array.isArray(body.models) ? body.models.map(String).map((m) => m.trim()).filter(Boolean) : [];
    if (runId && !SAFE_RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid run id.' }); return; }
    if (!runId && (!Number.isInteger(lastN) || lastN < 1)) { res.status(400).json({ error: 'Provide runId or positive lastN.' }); return; }
    if (models.length === 0) { res.status(400).json({ error: 'models must contain at least one model.' }); return; }

    const now = new Date().toISOString();
    const job: ReplayJob = {
      id: `replay-job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      request: { ...(runId ? { runId } : { lastN }), models },
    };
    jobs.unshift(job);
    if (jobs.length > MAX_JOBS) jobs.splice(MAX_JOBS);
    void runJob(job, projectDir, createClient, logger, schemaTools());
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  router.get('/api/replays', (_req, res) => {
    res.json({ jobs: jobs.map(({ id, status, createdAt, updatedAt, request, error }) => ({ id, status, createdAt, updatedAt, request, error })) });
  });

  router.get('/api/replays/:jobId', (req, res) => {
    const job = jobs.find((entry) => entry.id === req.params.jobId);
    if (!job) { res.status(404).json({ error: 'Replay job not found.' }); return; }
    res.json(job);
  });

  return router;
}

async function runJob(
  job: ReplayJob,
  projectDir: string,
  createClient: (model: string) => IChatClient | Promise<IChatClient>,
  logger: ReplayRoutesDeps['logger'],
  schemaTools?: Tool[],
): Promise<void> {
  try {
    if (job.request.runId) {
      const replayCase = await loadReplayCase(projectDir, job.request.runId);
      const replays = [];
      for (const model of job.request.models) {
        const client = await createClient(model);
        replays.push((await replayRun(replayCase, { client, model, schemaTools })).metrics);
      }
      job.report = compareRuns(replayCase.originalMetrics, replays);
    } else {
      job.report = await benchmarkHistory(projectDir, {
        models: job.request.models,
        lastN: job.request.lastN ?? 10,
        createClient: (model) => createClient(model),
        schemaTools,
      });
    }
    job.status = 'completed';
    job.updatedAt = new Date().toISOString();
    logger.info('Replay', 'Replay job completed', { jobId: job.id });
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = new Date().toISOString();
    logger.info('Replay', 'Replay job failed', { jobId: job.id, error: job.error });
  }
}
