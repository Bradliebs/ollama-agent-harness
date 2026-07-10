import express from 'express';
import path from 'path';
import { listArtifacts, readArtifact, type ArtifactCategory } from '../services/artifactCatalog';

export interface ArtifactRoutesDeps {
  projectDir: string;
}

export function createArtifactRouter(deps: ArtifactRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  const artifactRoot = (): string => {
    const override = (process.env.HARNESS_AGENT_OUTPUT_DIR ?? '').trim();
    if (override) {
      return path.isAbsolute(override) ? override : path.resolve(projectDir, override);
    }
    return path.join(projectDir, 'agent-outputs');
  };

  router.get('/api/artifacts', async (req, res) => {
    try {
      const limit = req.query.limit ? Math.max(1, Math.min(1000, Number(req.query.limit))) : undefined;
      const category = typeof req.query.category === 'string' ? req.query.category as ArtifactCategory : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const root = artifactRoot();
      const records = await listArtifacts(root, { limit, category, search });
      res.json({ root, count: records.length, artifacts: records });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/artifacts/content', async (req, res) => {
    try {
      const relative = typeof req.query.path === 'string' ? req.query.path : '';
      if (!relative) { res.status(400).json({ error: 'path query parameter required.' }); return; }
      const result = await readArtifact(artifactRoot(), relative);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
