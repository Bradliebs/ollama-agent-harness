import express from 'express';
import { verifyCode, verifyService } from '../core/doneStateVerifier';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && SAFE_ID_PATTERN.test(id) ? id : null;
}

export interface DoneStateRoutesDeps {
  projectDir: string;
}

export function createDoneStateRouter(deps: DoneStateRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.post('/api/verify/code', async (req, res) => {
    try {
      const quick = req.body?.quick === true;
      const result = await verifyCode({ projectDir, quick });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/verify/service/:id', async (req, res) => {
    try {
      const serviceId = safeLocalId(req.params.id);
      if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
      const result = await verifyService(projectDir, serviceId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
