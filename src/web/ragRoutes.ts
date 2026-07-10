import express from 'express';
import * as ragIndex from '../persistence/ragIndex';

export interface RagRoutesDeps {
  projectDir: string;
  /** Lazy getter so router sees live updates to the host setting in server.ts. */
  getOllamaHost: () => string;
}

export function createRagRouter(deps: RagRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/rag/indexes', async (_req, res) => {
    try {
      res.json({ indexes: await ragIndex.listIndexes(projectDir) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rag/build', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p: unknown) => String(p)) : [];
      const backend = req.body?.backend === 'ollama' || req.body?.backend === 'hash' ? req.body.backend : undefined;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      if (paths.length === 0) { res.status(400).json({ error: 'at least one path is required' }); return; }
      const result = await ragIndex.build(projectDir, name, paths, { backend, ollamaHost: deps.getOllamaHost() });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rag/preview', async (req, res) => {
    try {
      const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p: unknown) => String(p)) : [];
      if (paths.length === 0) { res.status(400).json({ error: 'at least one path is required' }); return; }
      const preview = await ragIndex.previewBuild(projectDir, paths);
      const backend = await ragIndex.selectBackend(deps.getOllamaHost(), undefined);
      res.json({ ...preview, backend });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rag/build/stream', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p: unknown) => String(p)) : [];
    const backend = req.body?.backend === 'ollama' || req.body?.backend === 'hash' ? req.body.backend : undefined;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    if (paths.length === 0) { res.status(400).json({ error: 'at least one path is required' }); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const writeEvent = (event: string, data: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    let aborted = false;
    res.on('close', () => { aborted = true; });
    try {
      for await (const event of ragIndex.iterateBuild(projectDir, name, paths, { backend, ollamaHost: deps.getOllamaHost() })) {
        if (aborted) break;
        writeEvent(event.stage, event);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      writeEvent('error', { message: msg });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  router.post('/api/rag/search', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const query = String(req.body?.query || '').trim();
      const k = Number.isFinite(req.body?.k) ? Math.max(1, Math.min(20, Number(req.body.k))) : 5;
      if (!name || !query) { res.status(400).json({ error: 'name and query are required' }); return; }
      const results = await ragIndex.search(projectDir, name, query, { k, ollamaHost: deps.getOllamaHost() });
      res.json({ results });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/rag/indexes/:name', async (req, res) => {
    try {
      const ok = await ragIndex.dropIndex(projectDir, req.params.name);
      if (!ok) { res.status(404).json({ error: 'index not found' }); return; }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
