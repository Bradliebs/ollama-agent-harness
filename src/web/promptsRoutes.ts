import express from 'express';
import {
  savePromptVersion,
  loadRegistry,
  listRegistries,
  getActivePrompt,
  setActiveVersion,
  rollback as rollbackPrompt,
  diffVersions,
  renderPromptHistory,
} from '../services/versionedPrompts';

export interface PromptsRoutesDeps {
  projectDir: string;
}

export function createPromptsRouter(deps: PromptsRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/prompts', async (_req, res) => {
    try {
      const names = await listRegistries(projectDir);
      res.json({ prompts: names });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/prompts/:name', async (req, res) => {
    try {
      const registry = await loadRegistry(projectDir, req.params.name);
      if (!registry) { res.status(404).json({ error: 'Prompt registry not found.' }); return; }
      res.json(registry);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/prompts/:name/active', async (req, res) => {
    try {
      const active = await getActivePrompt(projectDir, req.params.name);
      if (!active) { res.status(404).json({ error: 'No active prompt found.' }); return; }
      res.json(active);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/prompts/:name/versions', async (req, res) => {
    try {
      const { content, label, author, changelog, tags } = req.body ?? {};
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content is required.' });
        return;
      }
      const version = await savePromptVersion(projectDir, req.params.name, content, { label, author, changelog, tags });
      res.json(version);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/api/prompts/:name/active', async (req, res) => {
    try {
      const { version } = req.body ?? {};
      if (typeof version !== 'number') {
        res.status(400).json({ error: 'version (number) is required.' });
        return;
      }
      const ok = await setActiveVersion(projectDir, req.params.name, version);
      if (!ok) { res.status(404).json({ error: `Version ${version} not found.` }); return; }
      res.json({ activeVersion: version });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/prompts/:name/rollback', async (req, res) => {
    try {
      const prev = await rollbackPrompt(projectDir, req.params.name);
      if (!prev) { res.status(400).json({ error: 'Cannot rollback: only one version or registry not found.' }); return; }
      res.json(prev);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/prompts/:name/diff', async (req, res) => {
    try {
      const registry = await loadRegistry(projectDir, req.params.name);
      if (!registry) { res.status(404).json({ error: 'Prompt registry not found.' }); return; }
      const from = parseInt(req.query.from as string, 10);
      const to = parseInt(req.query.to as string, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        res.status(400).json({ error: 'from and to query params (version numbers) are required.' });
        return;
      }
      const diff = diffVersions(registry, from, to);
      if (!diff) { res.status(404).json({ error: 'One or both versions not found.' }); return; }
      res.json(diff);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/prompts/:name/history', async (req, res) => {
    try {
      const registry = await loadRegistry(projectDir, req.params.name);
      if (!registry) { res.status(404).json({ error: 'Prompt registry not found.' }); return; }
      res.json({ markdown: renderPromptHistory(registry) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
