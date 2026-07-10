import express from 'express';
import { cancelSubagent, listActiveSubagents } from '../services/subagentRegistry';

export interface SubagentRoutesDeps {
  projectDir: string;
  // Reads the server.ts module-level agentOutputDir override (UI-settable).
  // /api/subagent-runs returns it as a hint so the UI can show where files land.
  getAgentOutputDirOverride: () => string;
}

export function createSubagentRouter(deps: SubagentRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, getAgentOutputDirOverride } = deps;

  router.get('/api/subagents', async (_req, res) => {
    try {
      const records = listActiveSubagents().map((record) => ({
        id: record.id,
        name: record.name,
        promptSnippet: record.promptSnippet,
        startedAtMs: record.startedAtMs,
        durationMs: Date.now() - record.startedAtMs,
        lastActivity: record.lastActivity,
        updatedAtMs: record.updatedAtMs,
        activityHistory: record.activityHistory ?? [],
      }));
      res.json({ count: records.length, subagents: records });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/subagent-runs', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const { listSubagentRuns } = await import('../services/subagentRuns');
      const runs = await listSubagentRuns(projectDir, limit);
      res.json({ runs, outputDir: process.env.HARNESS_AGENT_OUTPUT_DIR || getAgentOutputDirOverride() || '' });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/subagent-runs/:runId', async (req, res) => {
    try {
      const { getSubagentRun } = await import('../services/subagentRuns');
      const run = await getSubagentRun(projectDir, String(req.params.runId));
      if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
      res.json({ run });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/subagents/:id/cancel', async (req, res) => {
    try {
      const ok = cancelSubagent(req.params.id);
      if (!ok) { res.status(404).json({ error: 'Sub-agent not found.' }); return; }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
