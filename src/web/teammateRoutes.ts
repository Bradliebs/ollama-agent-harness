import express from 'express';
import type { TeammateSettings, TeammateRunResult } from '../automation/teammateScheduler';

export interface TeammateStatus {
  settings: TeammateSettings;
  nextRunAt: string;
  schedulerRunning: boolean;
  telegramConfigured: boolean;
  discordConfigured: boolean;
  slackConfigured: boolean;
}

export interface TeammateRouterDeps {
  getStatus: () => TeammateStatus;
  applyTeammateConfig: (body: unknown) => Promise<{ settings: TeammateSettings; nextRunAt: string }>;
  runTeammateNow: () => Promise<TeammateRunResult>;
  isKillSwitchActive: () => boolean;
}

export function createTeammateRouter(deps: TeammateRouterDeps): express.Router {
  const router = express.Router();

  router.get('/api/teammate/status', async (_req, res) => {
    res.json(deps.getStatus());
  });

  router.post('/api/teammate/config', async (req, res) => {
    try {
      const next = await deps.applyTeammateConfig(req.body);
      res.json({ ok: true, settings: next.settings, nextRunAt: next.nextRunAt });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/teammate/run-now', async (_req, res) => {
    try {
      if (deps.isKillSwitchActive()) {
        res.status(409).json({ error: 'Kill switch is engaged. Release it first.' });
        return;
      }
      const result = await deps.runTeammateNow();
      res.json({ ok: result.fired, result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
