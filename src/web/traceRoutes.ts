import express from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { runtimeTracer } from '../core/tracing';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
function safeLocalId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id.length > 0 && SAFE_ID_PATTERN.test(id) ? id : null;
}

export interface TraceRoutesDeps {
  projectDir: string;
}

export function createTraceRouter(deps: TraceRoutesDeps): express.Router {
  const router = express.Router();
  const TRACES_DIR = path.join(deps.projectDir, '.harness', 'traces');

  router.get('/api/traces', (_req, res) => {
    res.json(runtimeTracer.snapshot());
  });

  router.delete('/api/traces', (_req, res) => {
    runtimeTracer.clear();
    res.json({ ok: true });
  });

  router.get('/api/traces/exports', async (_req, res) => {
    try {
      await fs.mkdir(TRACES_DIR, { recursive: true });
      const files = await fs.readdir(TRACES_DIR, { withFileTypes: true });
      const exports = [];
      for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
        const stat = await fs.stat(path.join(TRACES_DIR, file.name));
        exports.push({ id: file.name.replace(/\.json$/, ''), name: file.name, size: stat.size, createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString() });
      }
      exports.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      res.json({ exports });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/traces/exports', async (_req, res) => {
    try {
      await fs.mkdir(TRACES_DIR, { recursive: true });
      const snapshot = runtimeTracer.snapshot();
      const id = `trace-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const filePath = path.join(TRACES_DIR, `${id}.json`);
      await fs.writeFile(filePath, JSON.stringify({ id, exportedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf-8');
      res.json({ id, path: filePath, spans: snapshot.spans.length, events: snapshot.events.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/traces/exports/:id', async (req, res) => {
    const exportId = safeLocalId(req.params.id);
    if (!exportId) { res.status(400).json({ error: 'Invalid trace export id.' }); return; }
    try {
      const raw = await fs.readFile(path.join(TRACES_DIR, `${exportId}.json`), 'utf-8');
      res.type('application/json').send(raw);
    } catch {
      res.status(404).json({ error: 'Trace export not found.' });
    }
  });

  return router;
}
