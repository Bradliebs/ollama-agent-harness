import express from 'express';
import { loadSynthesisStats, adaptiveMaxTurns, adaptiveTimeBudget, clearSynthesisStats } from '../core/synthesisStats';

export interface SynthesisStatsRoutesDeps {
  projectDir: string;
}

export function createSynthesisStatsRouter(deps: SynthesisStatsRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/synthesis-stats', async (_req, res) => {
    try {
      const stats = await loadSynthesisStats(projectDir);
      const withAdaptive: Record<string, unknown> = {};
      for (const [model, record] of Object.entries(stats)) {
        const backend = model.includes('/') ? model.slice(0, model.indexOf('/')) : 'ollama';
        const isLocal = backend === 'ollama' && !model.includes('cloud');
        const defaultBudget = isLocal ? 180_000 : 600_000;
        const toolSuccessRate = record.toolCalls && record.toolCalls > 0 ? (record.toolSuccesses ?? 0) / record.toolCalls : undefined;
        const finalTextRate = record.total > 0 ? (record.finalTextResponses ?? 0) / record.total : undefined;
        withAdaptive[model] = {
          ...record,
          adaptiveMaxTurns: adaptiveMaxTurns(stats, model, 25),
          adaptiveTimeBudgetMs: adaptiveTimeBudget(stats, model, defaultBudget),
          toolSuccessRate,
          finalTextRate,
        };
      }
      res.json({ stats: withAdaptive, defaultMaxTurns: 25 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/api/synthesis-stats', async (req, res) => {
    try {
      const model = typeof req.query.model === 'string' ? req.query.model : undefined;
      await clearSynthesisStats(projectDir, model);
      res.json({ cleared: model ?? 'all' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
