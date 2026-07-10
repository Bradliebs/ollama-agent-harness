import express from 'express';
import {
  buildRepoGraph,
  analyzeImpact,
  summarizeRepo,
  saveRepoGraph,
  loadRepoGraph,
} from '../core/codeIntelligence';
import { emitEvent } from '../persistence/eventStore';
import { recordSwallowed } from '../observability/silentFailureSink';

export interface CodeIntelRoutesDeps {
  projectDir: string;
}

export function createCodeIntelRouter(deps: CodeIntelRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.post('/api/code-intelligence/build', async (_req, res) => {
    try {
      const graph = await buildRepoGraph(projectDir);
      await saveRepoGraph(projectDir, graph);
      const summary = summarizeRepo(graph);
      await emitEvent(projectDir, 'system', 'repo_graph_built', { files: summary.total_files, edges: summary.total_edges }, 'system').catch((err) => recordSwallowed('emitEvent', err));
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/code-intelligence/summary', async (_req, res) => {
    try {
      const graph = await loadRepoGraph(projectDir);
      if (!graph) { res.status(404).json({ error: 'No repo graph built yet. POST /api/code-intelligence/build first.' }); return; }
      res.json(summarizeRepo(graph));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/code-intelligence/impact', async (req, res) => {
    try {
      const files = req.body?.files as string[] | undefined;
      if (!Array.isArray(files) || files.length === 0) { res.status(400).json({ error: 'files array is required.' }); return; }
      const graph = await loadRepoGraph(projectDir);
      if (!graph) { res.status(404).json({ error: 'No repo graph. POST /api/code-intelligence/build first.' }); return; }
      const impact = analyzeImpact(graph, files);
      res.json(impact);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/code-intelligence/diagram', async (_req, res) => {
    try {
      const graph = await loadRepoGraph(projectDir);
      if (!graph) { res.status(404).json({ error: 'No repo graph. Build first.' }); return; }
      const { generateArchitectureDiagram } = await import('../core/codeIntelligence');
      const mermaid = generateArchitectureDiagram(graph);
      res.json({ mermaid });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
