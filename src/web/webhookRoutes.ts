import express from 'express';

import { addWebhook, listWebhooks, removeWebhook } from '../integrations/webhooks';

export function createWebhookRouter(): express.Router {
  const router = express.Router();

  router.get('/api/webhooks', (_req, res) => {
    res.json({ webhooks: listWebhooks() });
  });

  router.post('/api/webhooks', (req, res) => {
    try {
      const url = String(req.body?.url ?? '').trim();
      if (!url) { res.status(400).json({ error: 'url is required' }); return; }
      const secret = typeof req.body?.secret === 'string' ? req.body.secret.trim() : undefined;
      const events = Array.isArray(req.body?.events) ? req.body.events.map(String) : [];
      const webhook = addWebhook({ url, secret, events, enabled: true });
      // Redact secret in the response so it doesn't echo back into UI logs.
      res.json({ ok: true, webhook: { ...webhook, secret: secret ? '***' : undefined } });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/webhooks/:id', (req, res) => {
    const removed = removeWebhook(String(req.params.id));
    if (!removed) { res.status(404).json({ error: 'Webhook not found' }); return; }
    res.json({ ok: true });
  });

  return router;
}
