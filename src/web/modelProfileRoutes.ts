import express from 'express';
import type { IChatClient } from '../core/chatClient';
import {
  listCapabilityProfiles,
  loadCapabilityProfile,
  type CapabilityProfile,
} from '../models/capabilityProfile';
import { runProbeSuite } from '../models/probeRunner';

export interface ModelProfileRoutesDeps {
  projectDir: string;
  createClient: (model: string) => IChatClient | Promise<IChatClient>;
  requireAuth: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
  logger: {
    info?: (component: string, message: string, meta?: Record<string, unknown>) => void;
    error?: (component: string, message: string, meta?: Record<string, unknown>) => void;
  };
}

type JobStatus = 'running' | 'completed' | 'failed';

interface ProbeJob {
  id: string;
  model: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  profile?: CapabilityProfile;
  error?: string;
}

export function createModelProfileRouter(deps: ModelProfileRoutesDeps): express.Router {
  const router = express.Router();
  const jobs = new Map<string, ProbeJob>();

  router.get('/api/model-profiles', async (_req, res) => {
    try {
      res.json({ profiles: await listCapabilityProfiles(deps.projectDir) });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  router.get('/api/model-profiles/probe-jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) { res.status(404).json({ error: 'Probe job not found.' }); return; }
    res.json({ job });
  });

  router.get('/api/model-profiles/:model/probe/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.model !== req.params.model) { res.status(404).json({ error: 'Probe job not found.' }); return; }
    res.json({ job });
  });

  router.get('/api/model-profiles/:model', async (req, res) => {
    try {
      const profile = await loadCapabilityProfile(req.params.model, deps.projectDir);
      if (!profile) { res.status(404).json({ error: 'Model profile not found.' }); return; }
      res.json({ profile });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  router.post('/api/model-profiles/:model/probe', async (req, res) => {
    if (!deps.requireAuth(req, res, 'model profile probe')) return;
    const model = req.params.model;
    const job: ProbeJob = {
      id: `probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      model,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    res.status(202).json({ jobId: job.id, statusUrl: `/api/model-profiles/probe-jobs/${job.id}` });

    void (async () => {
      try {
        deps.logger.info?.('ModelProfile', 'Probe job started', { model, jobId: job.id });
        const client = await deps.createClient(model);
        job.profile = await runProbeSuite(client, {
          model,
          projectDir: deps.projectDir,
          budget: parseBudget(req.body?.budget),
        });
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        deps.logger.info?.('ModelProfile', 'Probe job completed', { model, jobId: job.id });
      } catch (error) {
        job.status = 'failed';
        job.error = errorMessage(error);
        job.completedAt = new Date().toISOString();
        deps.logger.error?.('ModelProfile', 'Probe job failed', { model, jobId: job.id, error: job.error });
      }
    })();
  });

  return router;
}

function parseBudget(value: unknown): { samples?: number; tokenBudgetPerProbe?: number; maxContextTokens?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  return {
    samples: numberOption(input.samples),
    tokenBudgetPerProbe: numberOption(input.tokenBudgetPerProbe),
    maxContextTokens: numberOption(input.maxContextTokens),
  };
}

function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
