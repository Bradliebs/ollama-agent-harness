import express from 'express';
import { createSquad, deleteSquad, getSquad, listSquads, routeMessage, updateSquad } from '../services/squad';

export interface SquadRoutesDeps {
  projectDir: string;
}

export function createSquadRouter(deps: SquadRoutesDeps): express.Router {
  const router = express.Router();

  router.get('/api/squads', async (_req, res) => {
    try {
      const squads = await listSquads(deps.projectDir);
      res.json({ squads });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/squads/:id', async (req, res) => {
    try {
      const squad = await getSquad(deps.projectDir, req.params.id);
      if (!squad) { res.status(404).json({ error: 'Squad not found.' }); return; }
      res.json({ squad });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/squads', async (req, res) => {
    try {
      const squad = await createSquad(deps.projectDir, req.body ?? {});
      res.json({ squad });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('already exists') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.patch('/api/squads/:id', async (req, res) => {
    try {
      const squad = await updateSquad(deps.projectDir, req.params.id, req.body ?? {});
      res.json({ squad });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.delete('/api/squads/:id', async (req, res) => {
    try {
      const removed = await deleteSquad(deps.projectDir, req.params.id);
      if (!removed) { res.status(404).json({ error: 'Squad not found.' }); return; }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/squads/:id/route', async (req, res) => {
    try {
      const squad = await getSquad(deps.projectDir, req.params.id);
      if (!squad) { res.status(404).json({ error: 'Squad not found.' }); return; }
      const message = typeof req.body?.message === 'string' ? req.body.message : '';
      if (!message.trim()) { res.status(400).json({ error: 'message is required.' }); return; }
      res.json({ result: routeMessage(squad, message) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
