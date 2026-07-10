import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { CostTracker } from '../eval/costTracker';

export interface RuntimeCostRoutesDeps {
  projectDir: string;
  tracesDir: string;
}

async function directoryJsonStats(dirPath: string): Promise<{ count: number; bytes: number }> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const stat = await fs.stat(path.join(dirPath, entry.name));
      count++;
      bytes += stat.size;
    }
    return { count, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

async function fileStats(filePath: string): Promise<{ exists: boolean; bytes: number }> {
  try {
    const stat = await fs.stat(filePath);
    return { exists: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

export function createRuntimeCostRouter(deps: RuntimeCostRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, tracesDir } = deps;

  const getRuntimeStorageSummary = async () => ({
    traces: await directoryJsonStats(tracesDir),
    semanticIndex: await fileStats(path.join(projectDir, '.harness', 'memory', 'semantic-index.json')),
  });

  router.get('/api/cost/rates', (_req, res) => {
    res.json({ rates: CostTracker.getAllRates() });
  });

  router.post('/api/cost/rates', (req, res) => {
    const { model, input, output } = req.body ?? {};
    if (!model || typeof input !== 'number' || typeof output !== 'number') {
      res.status(400).json({ error: 'model, input (number), and output (number) are required' });
      return;
    }
    CostTracker.registerRate(model, { input, output });
    res.json({ ok: true, model, rate: { input, output } });
  });

  router.get('/api/runtime/storage', async (_req, res) => {
    try {
      res.json(await getRuntimeStorageSummary());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/runtime/cleanup', async (req, res) => {
    try {
      const cleaned: string[] = [];
      if (Boolean(req.body.traces)) {
        await fs.rm(tracesDir, { recursive: true, force: true });
        cleaned.push('traces');
      }
      if (Boolean(req.body.semanticIndex)) {
        await fs.rm(path.join(projectDir, '.harness', 'memory', 'semantic-index.json'), { force: true });
        cleaned.push('semanticIndex');
      }
      res.json({ cleaned, storage: await getRuntimeStorageSummary() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
