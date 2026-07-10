import express from 'express';
import { runBenchmark, loadBenchmarkRuns, summarizeByTier, type BenchmarkTier } from '../eval/benchmark';
import { runComparison } from '../eval/abCompare';

const VALID_TIERS: BenchmarkTier[] = ['canned', 'stress', 'adversarial', 'regression'];

export interface BenchmarkRoutesDeps {
  projectDir: string;
  getCurrentModel: () => string;
  sanitizeModelName: (value: unknown) => string;
  getBaseUrl: () => string;
}

export function createBenchmarkRouter(deps: BenchmarkRoutesDeps): express.Router {
  const router = express.Router();

  router.post('/api/benchmark/run', async (req, res) => {
    try {
      const rawTiers = req.body?.tiers;
      const tiers: BenchmarkTier[] | undefined = Array.isArray(rawTiers)
        ? rawTiers.filter((t): t is BenchmarkTier => VALID_TIERS.includes(t))
        : undefined;
      const model = typeof req.body?.model === 'string' ? req.body.model : deps.getCurrentModel();
      const run = await runBenchmark({
        baseUrl: deps.getBaseUrl(),
        model: deps.sanitizeModelName(model) ?? undefined,
        tiers,
        filterIds: Array.isArray(req.body?.filterIds) ? req.body.filterIds.map(String) : undefined,
        perTaskTimeoutMs: typeof req.body?.perTaskTimeoutMs === 'number' ? req.body.perTaskTimeoutMs : 60_000,
        projectDir: deps.projectDir,
      });
      res.json({ run, summary: summarizeByTier(run) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/benchmark/runs', async (_req, res) => {
    try {
      const runs = await loadBenchmarkRuns(deps.projectDir);
      const summaries = runs.map(({ results: _results, ...rest }) => ({
        ...rest,
        tierBreakdown: summarizeByTier({ results: _results, ...rest }),
      }));
      res.json({ runs: summaries });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/benchmark/runs/:id', async (req, res) => {
    const id = req.params.id?.replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!id) { res.status(400).json({ error: 'Invalid run id' }); return; }
    try {
      const runs = await loadBenchmarkRuns(deps.projectDir);
      const run = runs.find((r) => r.id === id);
      if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
      res.json({ run, summary: summarizeByTier(run) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/benchmark/compare', async (req, res) => {
    const { modelA, modelB, tiers, filterIds } = req.body ?? {};
    if (!modelA || !modelB) { res.status(400).json({ error: 'modelA and modelB are required' }); return; }
    try {
      const result = await runComparison({
        modelA,
        modelB,
        benchmarkOptions: {
          baseUrl: deps.getBaseUrl(),
          tiers: tiers as BenchmarkTier[] | undefined,
          filterIds,
          projectDir: deps.projectDir,
        },
      });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
