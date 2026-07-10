import express from 'express';

import { addWebhook, discardDeadLetter, listDeadLetters, listWebhooks, redeliverDeadLetter, removeWebhook, testWebhook, updateWebhook } from '../integrations/webhooks';

export function createWebhookRouter(): express.Router {
  const router = express.Router();

  router.get('/api/webhooks', (_req, res) => {
    res.json({ webhooks: listWebhooks() });
  });

  // Dead-letter routes are registered before '/api/webhooks/:id' so the
  // 'dead-letter' path segment is never captured as a webhook id.
  router.get('/api/webhooks/dead-letter', (_req, res) => {
    res.json({ deadLetters: listDeadLetters() });
  });

  router.post('/api/webhooks/dead-letter/:id/redeliver', async (req, res) => {
    const result = await redeliverDeadLetter(String(req.params.id));
    if (result.ok) { res.json({ ok: true }); return; }
    if (result.reason === 'not found') { res.status(404).json({ error: 'Dead-letter entry not found' }); return; }
    if (result.reason === 'webhook no longer configured') { res.status(409).json({ error: result.reason }); return; }
    res.status(502).json({ error: 'Redelivery failed; entry retained for another attempt.' });
  });

  router.delete('/api/webhooks/dead-letter/:id', (req, res) => {
    const removed = discardDeadLetter(String(req.params.id));
    if (!removed) { res.status(404).json({ error: 'Dead-letter entry not found' }); return; }
    res.json({ ok: true });
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

  // Fire a synthetic ping at one configured webhook so a user can validate the
  // URL/secret before relying on it. The ':id/test' shape is matched as a
  // specific route (4 path segments), distinct from the '/api/webhooks/:id'
  // param catch-all and the dead-letter routes above.
  router.post('/api/webhooks/:id/test', async (req, res) => {
    const result = await testWebhook(String(req.params.id));
    if (result.reason === 'not found') { res.status(404).json({ error: 'Webhook not found' }); return; }
    if (result.ok) { res.json({ ok: true, status: result.status }); return; }
    res.status(502).json({ ok: false, status: result.status, error: result.error ?? 'Delivery failed' });
  });

  router.patch('/api/webhooks/:id', (req, res) => {
    const patch: { enabled?: boolean; events?: string[] } = {};
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (Array.isArray(req.body?.events)) patch.events = req.body.events.map(String);
    const updated = updateWebhook(String(req.params.id), patch);
    if (!updated) { res.status(404).json({ error: 'Webhook not found' }); return; }
    res.json({ ok: true, webhook: updated });
  });

  router.delete('/api/webhooks/:id', (req, res) => {
    const removed = removeWebhook(String(req.params.id));
    if (!removed) { res.status(404).json({ error: 'Webhook not found' }); return; }
    res.json({ ok: true });
  });

  return router;
}
