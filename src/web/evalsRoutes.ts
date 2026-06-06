import express from 'express';
import {
  appendEvalTraceExample,
  createEvalTraceExample,
  createReplayEvalExample,
  deleteEvalTraceExample,
  listEvalTraceExamples,
  listEvalTraceRuns,
  readEvalTraceDataset,
  runEvalTraceDataset,
  summarizeContextLossRuns,
  summarizeEvalTraceRuns,
  summarizeOutputValidationRuns,
  summarizeProfileFeedbackRuns,
  summarizeUploadsFallbackRuns,
  updateEvalTraceExampleTags,
} from '../learning/evalTrace';

function safeEvalExampleId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && /^[a-zA-Z0-9:._-]+$/.test(id) ? id : null;
}

export type ReplayAdapter = (example: {
  prompt?: string;
  task: string;
  actualResponse?: string;
  actualTools?: string[];
}) => Promise<{ actualResponse: string; actualTools: string[] }>;

export interface EvalsRouterDeps {
  projectDir: string;
  /** Build the live-mode replay adapter, or return null when no active model is available. */
  buildLiveAdapter: (requestedModel: unknown) => Promise<ReplayAdapter | null>;
  /** Snapshot of the in-memory runtime tracer used by /api/evals/trace-examples POST. */
  getRuntimeTracerSnapshot: () => Parameters<typeof createEvalTraceExample>[0];
}

export function createEvalsRouter(deps: EvalsRouterDeps): express.Router {
  const router = express.Router();

  router.get('/api/evals/trace-examples', async (_req, res) => {
    try {
      const examples = await listEvalTraceExamples(deps.projectDir);
      res.json({ examples });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/evals/trace-examples/download', async (_req, res) => {
    try {
      const raw = await readEvalTraceDataset(deps.projectDir);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="trace-examples.jsonl"');
      res.send(raw);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/evals/runs', async (_req, res) => {
    try {
      const runs = await listEvalTraceRuns(deps.projectDir);
      res.json({
        runs,
        trend: summarizeEvalTraceRuns(runs),
        outputValidationTrend: summarizeOutputValidationRuns(runs),
        profileFeedbackTrend: summarizeProfileFeedbackRuns(runs),
        contextLossTrend: summarizeContextLossRuns(runs),
        uploadsFallbackTrend: summarizeUploadsFallbackRuns(runs),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/evals/trace-examples/run', async (req, res) => {
    try {
      const mode: 'live' | 'mock' | 'stored' = req.body?.mode === 'live' || req.body?.mode === 'mock' ? req.body.mode : 'stored';
      let replayAdapter: ReplayAdapter | undefined;
      if (mode === 'mock') {
        replayAdapter = async (example) => ({
          actualResponse: req.body?.mockResponse?.toString() ?? example.actualResponse ?? '',
          actualTools: Array.isArray(req.body?.mockTools) ? req.body.mockTools.map(String) : (example.actualTools ?? []),
        });
      } else if (mode === 'live') {
        const live = await deps.buildLiveAdapter(req.body?.model);
        replayAdapter = live ?? (async () => ({ actualResponse: '', actualTools: [] }));
      }
      const run = await runEvalTraceDataset(deps.projectDir, { replayAdapter });
      const runs = await listEvalTraceRuns(deps.projectDir);
      res.json({ run, trend: summarizeEvalTraceRuns(runs), mode });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/api/evals/trace-examples/:id/tags', async (req, res) => {
    const exampleId = safeEvalExampleId(req.params.id);
    if (!exampleId) { res.status(400).json({ error: 'Invalid eval example id.' }); return; }
    try {
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : String(req.body?.tags ?? '').split(',');
      const example = await updateEvalTraceExampleTags(deps.projectDir, exampleId, tags);
      res.json({ example });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/evals/trace-examples/:id', async (req, res) => {
    const exampleId = safeEvalExampleId(req.params.id);
    if (!exampleId) { res.status(400).json({ error: 'Invalid eval example id.' }); return; }
    try {
      const deleted = await deleteEvalTraceExample(deps.projectDir, exampleId);
      if (!deleted) { res.status(404).json({ error: 'Eval trace example not found.' }); return; }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/evals/trace-examples', async (req, res) => {
    try {
      const example = createEvalTraceExample(deps.getRuntimeTracerSnapshot(), {
        task: req.body?.task?.toString() || 'web runtime trace',
        expectedBehavior: req.body?.expectedBehavior?.toString() || undefined,
        tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : ['web', 'runtime'],
      });
      const filePath = await appendEvalTraceExample(deps.projectDir, example);
      res.json({ example, path: filePath });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/evals/replay-examples', async (req, res) => {
    try {
      const example = createReplayEvalExample({
        task: req.body?.task?.toString() || 'replay regression',
        prompt: req.body?.prompt?.toString() || '',
        expectedBehavior: req.body?.expectedBehavior?.toString() || undefined,
        expectedResponseIncludes: Array.isArray(req.body?.expectedResponseIncludes) ? req.body.expectedResponseIncludes.map(String) : [],
        expectedTools: Array.isArray(req.body?.expectedTools) ? req.body.expectedTools.map(String) : [],
        actualResponse: req.body?.actualResponse?.toString() || undefined,
        actualTools: Array.isArray(req.body?.actualTools) ? req.body.actualTools.map(String) : [],
        sourceTraceId: req.body?.sourceTraceId?.toString() || undefined,
        sourceSessionId: req.body?.sourceSessionId?.toString() || undefined,
        sourceContext: req.body?.sourceContext?.toString() || undefined,
        tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : ['replay'],
      });
      const filePath = await appendEvalTraceExample(deps.projectDir, example);
      res.json({ example, path: filePath });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
