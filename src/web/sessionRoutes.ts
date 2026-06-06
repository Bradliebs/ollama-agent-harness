import express from 'express';
import { SessionStorage } from '../persistence/sessionStorage';
import { forkSession, resumeSession } from '../persistence/resume';
import { getSessionSearchIndexStatus, rebuildSessionSearchIndexWithMetadata } from '../persistence/sessionSearchIndex';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && SAFE_ID_PATTERN.test(id) ? id : null;
}

export interface SessionRoutesDeps {
  projectDir: string;
  // server.ts holds the mutable currentModel; the resume / fork / import
  // routes need its current value at request time, so we accept a callable
  // instead of snapshotting the value at construction.
  getCurrentModel: () => string;
}

export function createSessionRouter(deps: SessionRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, getCurrentModel } = deps;

  router.post('/api/sessions/search-index/rebuild', async (_req, res) => {
    try {
      const index = await rebuildSessionSearchIndexWithMetadata(projectDir);
      const status = await getSessionSearchIndexStatus(projectDir);
      res.json({ index, status });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/sessions', async (_req, res) => {
    try {
      const sessions = await SessionStorage.listSessions(projectDir);
      res.json({ sessions });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/sessions/recover', async (_req, res) => {
    try {
      const sessions = await SessionStorage.listRecoverableSessions(projectDir);
      res.json({ sessions });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/sessions/:id', async (req, res) => {
    try {
      const sessionId = safeLocalId(req.params.id);
      if (!sessionId) { res.status(400).json({ error: 'Invalid session id.' }); return; }
      const activeModel = getCurrentModel() || req.query.model?.toString() || 'unknown';
      const result = await resumeSession(projectDir, sessionId, activeModel);
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/sessions/:id/fork', async (req, res) => {
    try {
      const sessionId = safeLocalId(req.params.id);
      if (!sessionId) { res.status(400).json({ error: 'Invalid session id.' }); return; }
      const activeModel = req.body.model || getCurrentModel();
      if (!activeModel) { res.status(400).json({ error: 'No model selected.' }); return; }
      const result = await forkSession(projectDir, sessionId, activeModel);
      res.json({ sessionId: result.newStorage.getSessionId(), messageCount: result.messages.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/sessions/:id/export', async (req, res) => {
    try {
      const sessionId = safeLocalId(req.params.id);
      if (!sessionId) { res.status(400).json({ error: 'Invalid session id.' }); return; }
      const storage = new SessionStorage(projectDir, '', sessionId);
      const [meta, events] = await Promise.all([storage.getMeta(), storage.readAll()]);
      const exportData = { meta, events, exportedAt: new Date().toISOString() };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="session-${sessionId.slice(0, 8)}.json"`);
      res.json(exportData);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/sessions/import', async (req, res) => {
    try {
      const body = req.body;
      if (!body?.meta || !Array.isArray(body?.events)) {
        res.status(400).json({ error: 'Invalid session export: must have meta and events array.' });
        return;
      }
      const model = body.meta.model || getCurrentModel() || 'imported';
      const storage = new SessionStorage(projectDir, model);
      await storage.initialize();
      if (body.meta.title) storage.setMeta('title', body.meta.title);
      for (const event of body.events) {
        if (event.type && event.data) {
          await storage.append(event.type, event.data);
        }
      }
      await storage.markStatus(body.meta.status || 'completed');
      await rebuildSessionSearchIndexWithMetadata(projectDir);
      res.json({ sessionId: storage.getSessionId(), eventCount: body.events.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
