import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { buildMemoryPalace, getSemanticMemoryContext, getSemanticMemoryEntry, rebuildSemanticMemory, searchSemanticMemory } from '../persistence/semanticMemory';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && SAFE_ID_PATTERN.test(id) ? id : null;
}
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export interface MemoryRoutesDeps {
  projectDir: string;
}

export function createMemoryRouter(deps: MemoryRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.post('/api/memory/rebuild', async (_req, res) => {
    try {
      const entries = await rebuildSemanticMemory(projectDir);
      res.json({ entries: entries.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/memory/search', async (req, res) => {
    try {
      const query = req.query.q?.toString() ?? '';
      const results = await searchSemanticMemory(projectDir, query.slice(0, 500));
      res.json({ results });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/memory/entries/:id', async (req, res) => {
    const entryId = safeLocalId(req.params.id);
    if (!entryId) { res.status(400).json({ error: 'Invalid memory entry id.' }); return; }
    try {
      const entry = await getSemanticMemoryEntry(projectDir, entryId);
      if (!entry) { res.status(404).json({ error: 'Memory entry not found.' }); return; }
      res.json({ entry });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/memory/entries/:id/context', async (req, res) => {
    const entryId = safeLocalId(req.params.id);
    if (!entryId) { res.status(400).json({ error: 'Invalid memory entry id.' }); return; }
    try {
      const context = await getSemanticMemoryContext(projectDir, entryId, clampNumber(req.query.window, 1, 10, 3));
      if (!context) { res.status(404).json({ error: 'Memory entry not found.' }); return; }
      res.json(context);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/memory/palace', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const palace = await buildMemoryPalace(projectDir, query || undefined);
      res.json(palace);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- API: Agent Memory ---
  // Reads the curated decisions/patterns/notes markdown the harness
  // maintains in .harness/memory/. Distinct from the semantic-memory
  // endpoints above (those live in eventStore + embeddings).
  router.get('/api/memory', async (_req, res) => {
    const memDir = path.join(projectDir, '.harness', 'memory');
    const result: Record<string, string> = {};
    for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
      try {
        result[file.replace('.md', '')] = await fs.readFile(path.join(memDir, file), 'utf-8');
      } catch { /* not yet created */ }
    }
    res.json(result);
  });

  return router;
}
