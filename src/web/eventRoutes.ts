import express from 'express';
import {
  emitEvent,
  queryEvents,
  summarizeEventStore,
  generatePostmortem,
  getSnapshot,
  listSnapshots,
  subscribeEventStream,
  type EventCategory,
} from '../persistence/eventStore';

export interface EventRoutesDeps {
  projectDir: string;
}

export function createEventRouter(deps: EventRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/events', async (req, res) => {
    try {
      const query = {
        category: req.query.category as EventCategory | undefined,
        type: typeof req.query.type === 'string' ? req.query.type : undefined,
        subject_id: typeof req.query.subject_id === 'string' ? req.query.subject_id : undefined,
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
        limit: typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 50 : 50,
        actor: typeof req.query.actor === 'string' ? req.query.actor : undefined,
      };
      const events = await queryEvents(projectDir, query);
      res.json({ total: events.length, events });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/events/summary', async (_req, res) => {
    try {
      const summary = await summarizeEventStore(projectDir);
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/events/postmortem/:id', async (req, res) => {
    try {
      const subjectId = req.params.id;
      const window = typeof req.query.window === 'string' ? parseInt(req.query.window, 10) || 30 : 30;
      const postmortem = await generatePostmortem(projectDir, subjectId, window);
      res.json({ postmortem });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/events/snapshots', async (_req, res) => {
    try {
      const subjects = await listSnapshots(projectDir);
      res.json({ subjects });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/events/snapshots/:id', async (req, res) => {
    try {
      const snapshot = await getSnapshot(projectDir, req.params.id);
      if (!snapshot) { res.status(404).json({ error: 'Snapshot not found.' }); return; }
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const unsubscribe = subscribeEventStream((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  router.post('/api/events', async (req, res) => {
    try {
      const { category, type, data, actor, subject_id, parent_event_id } = req.body ?? {};
      if (!category || !type) { res.status(400).json({ error: 'category and type are required.' }); return; }
      const validCategories: EventCategory[] = ['service', 'promise', 'task', 'tool', 'model', 'route', 'approval', 'file', 'schedule', 'notification', 'permission', 'system'];
      if (!validCategories.includes(category)) { res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` }); return; }
      const event = await emitEvent(projectDir, category, type, data ?? {}, actor ?? 'external', subject_id, parent_event_id);
      res.json(event);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
