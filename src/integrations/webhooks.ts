// Webhook notification channel for the Ollama Agent Harness.
//
// Sends POST requests to configured webhook URLs when automation jobs
// complete, autonomy runs finish, or other notable events occur.
//
// Configure via Settings → API Keys:
//   HARNESS_WEBHOOK_URL — primary webhook endpoint
//   HARNESS_WEBHOOK_SECRET — optional shared secret for HMAC signing
//
// Or via the webhooks API:
//   POST /api/webhooks { url, secret?, events? }
//   GET  /api/webhooks
//   DELETE /api/webhooks/:id

import * as crypto from 'crypto';
import { logger } from '../core/logger';

export interface WebhookConfig {
  id: string;
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
}

export type WebhookEventType =
  | 'automation.completed'
  | 'autonomy.completed'
  | 'autonomy.failed'
  | 'task.added'
  | 'task.completed'
  | 'email.sent'
  | 'health.daily'
  | 'promise.breach';

interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

const webhooks: WebhookConfig[] = [];

export function addWebhook(config: Omit<WebhookConfig, 'id'>): WebhookConfig {
  const id = `wh-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const webhook: WebhookConfig = { id, ...config };
  webhooks.push(webhook);
  return webhook;
}

export function removeWebhook(id: string): boolean {
  const idx = webhooks.findIndex((w) => w.id === id);
  if (idx === -1) return false;
  webhooks.splice(idx, 1);
  return true;
}

export function listWebhooks(): WebhookConfig[] {
  return webhooks.map((w) => ({ ...w, secret: w.secret ? '***' : undefined }));
}

export function loadWebhooksFromEnv(): void {
  const url = process.env.HARNESS_WEBHOOK_URL?.trim();
  if (url) {
    const existing = webhooks.find((w) => w.url === url);
    if (!existing) {
      addWebhook({
        url,
        secret: process.env.HARNESS_WEBHOOK_SECRET?.trim(),
        events: ['automation.completed', 'autonomy.completed', 'autonomy.failed'],
        enabled: true,
      });
      logger.info('Webhook', 'Loaded webhook from env', { url });
    }
  }
}

export async function sendWebhookNotification(event: WebhookEventType, data: Record<string, unknown>): Promise<number> {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);
  let sent = 0;

  for (const webhook of webhooks) {
    if (!webhook.enabled) continue;
    if (webhook.events.length > 0 && !webhook.events.includes(event)) continue;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (webhook.secret) {
        const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }
      headers['X-Webhook-Event'] = event;

      const res = await fetch(webhook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        sent++;
        logger.info('Webhook', 'Delivered', { event, url: webhook.url, status: res.status });
      } else {
        logger.warn('Webhook', 'Delivery failed', { event, url: webhook.url, status: res.status });
      }
    } catch (err) {
      logger.warn('Webhook', 'Delivery error', { event, url: webhook.url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return sent;
}
