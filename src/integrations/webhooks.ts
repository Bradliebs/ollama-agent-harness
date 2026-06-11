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
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { logger } from '../core/logger';

export interface WebhookConfig {
  id: string;
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
}

/** Transient (non-persisted) record of the most recent delivery attempt. */
export interface WebhookDeliveryStatus {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
  at: string;
  event?: string;
}

/**
 * A delivery that exhausted all retries (or hit a permanent 4xx). Persisted so
 * failed notifications survive a restart and can be redelivered or discarded
 * manually. The original payload `body` is retained verbatim so a redelivery
 * sends exactly what failed; webhook secrets are NOT stored here (the live
 * webhook config is consulted for HMAC signing on redelivery).
 */
export interface WebhookDeadLetter {
  id: string;
  webhookId: string;
  url: string;
  event: WebhookEventType;
  body: string;
  status?: number;
  error?: string;
  attempts: number;
  failedAt: string;
}

export type WebhookEventType =
  | 'automation.completed'
  | 'autonomy.completed'
  | 'autonomy.failed'
  | 'task.added'
  | 'task.completed'
  | 'email.sent'
  | 'health.daily'
  | 'promise.breach'
  | 'teammate.brief';

interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

const webhooks: WebhookConfig[] = [];

// Most recent delivery outcome per webhook id. Kept separate from the
// persisted registry so disk state stays clean and never shows stale status
// after a restart. Bounded by the number of webhooks (entries are dropped when
// a webhook is removed).
const deliveryStatus = new Map<string, WebhookDeliveryStatus>();

// Bounded ring of recent delivery outcomes per webhook id (newest first). Lets
// the UI show a short timeline and flag flapping endpoints. In-memory only, so
// it resets on restart like deliveryStatus, and bounded so a chatty webhook
// cannot grow it without limit; entries are dropped when a webhook is removed.
const deliveryHistory = new Map<string, WebhookDeliveryStatus[]>();
const MAX_DELIVERY_HISTORY = 10;

// Delays BETWEEN delivery attempts (ms); total attempts = delays.length + 1.
// Bounded so a flaky endpoint cannot stall the notify path indefinitely.
const DEFAULT_RETRY_DELAYS_MS = [500, 2000];
let retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS;

/** Test hook: shrink retry delays so suites do not wait on real backoff. */
export function setWebhookRetryDelaysForTest(delays: number[]): void {
  retryDelaysMs = delays;
}

// In-flight persist promises. The persist helpers are fire-and-forget (so
// add/remove keep their sync signatures), which races a test's temp-dir
// cleanup: the atomic write's temp file can outlive the persist call and make
// rmSync throw ENOTEMPTY. Tracking the promises lets suites await them.
const pendingWrites: Set<Promise<unknown>> = new Set();

function trackWrite(p: Promise<unknown>): void {
  pendingWrites.add(p);
  void p.finally(() => pendingWrites.delete(p));
}

/** Test hook: await all in-flight persist writes before cleaning up temp dirs. */
export async function flushWebhookWritesForTest(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

// Absolute path to the on-disk registry. Null until initWebhookStore() runs,
// in which case add/remove stay purely in-memory (tests, headless callers).
let storePath: string | null = null;

// Absolute path to the dead-letter store. Null until initWebhookStore() runs.
let deadLetterStorePath: string | null = null;

// Deliveries that exhausted every retry (or hit a permanent 4xx). Newest
// first and bounded: oldest entries are dropped past MAX_DEAD_LETTERS so a
// sustained outage cannot grow the file without limit. Persisted to disk
// (0o600) so failed notifications survive a restart for manual redelivery.
const deadLetters: WebhookDeadLetter[] = [];
const MAX_DEAD_LETTERS = 50;

// Age cap for dead-letters. Entries older than this are pruned on load and on
// every list, so an abandoned endpoint cannot leave stale payloads on disk
// forever. Bounded by MAX_DEAD_LETTERS as well; whichever limit hits first wins.
const DEFAULT_DEAD_LETTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let deadLetterMaxAgeMs = DEFAULT_DEAD_LETTER_MAX_AGE_MS;

/** Test hook: shrink the dead-letter age cap so suites can exercise expiry. */
export function setDeadLetterMaxAgeForTest(maxAgeMs: number): void {
  deadLetterMaxAgeMs = maxAgeMs;
}

// Reduce a webhook URL to scheme + host[:port] for logging. Webhook secrets are
// commonly embedded in the PATH (Slack/Discord) or query string, so logging the
// full URL on every attempt would leak them into log files. The full URL is
// still kept in memory / on the 0o600 store for actual delivery and redelivery.
function redactWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '[unparseable url]';
  }
}

// Drop dead-letters older than the age cap. Returns true when anything was
// removed so callers can decide whether to persist. Mutates in place.
function pruneExpiredDeadLetters(): boolean {
  if (deadLetters.length === 0) return false;
  const cutoff = Date.now() - deadLetterMaxAgeMs;
  const before = deadLetters.length;
  for (let i = deadLetters.length - 1; i >= 0; i--) {
    if (new Date(deadLetters[i].failedAt).getTime() < cutoff) deadLetters.splice(i, 1);
  }
  return deadLetters.length !== before;
}

/**
 * Point the registry at `<projectDir>/.harness/webhooks.json` and load any
 * previously saved webhooks. Called once at server boot. Loading is sync so
 * the registry is populated before the first notification can fire; the file
 * holds webhook secrets, so it is written with 0o600 (see persistWebhooks()).
 */
export function initWebhookStore(projectDir: string): void {
  storePath = path.join(projectDir, '.harness', 'webhooks.json');
  // Clear unconditionally so a missing or unreadable file resets the in-memory
  // registry instead of leaving a prior project's webhooks loaded (mirrors the
  // dead-letter block below). Then load any saved entries.
  webhooks.length = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.url !== 'string') continue;
        webhooks.push({
          id: entry.id,
          url: entry.url,
          secret: typeof entry.secret === 'string' ? entry.secret : undefined,
          events: Array.isArray(entry.events) ? entry.events.map(String) : [],
          enabled: entry.enabled !== false,
        });
      }
    }
  } catch {
    // No store yet (or unreadable) — start empty; the file is created on first write.
  }

  deadLetterStorePath = path.join(projectDir, '.harness', 'webhook-deadletter.json');
  deadLetters.length = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(deadLetterStorePath, 'utf-8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.body !== 'string') continue;
        deadLetters.push({
          id: entry.id,
          webhookId: typeof entry.webhookId === 'string' ? entry.webhookId : '',
          url: typeof entry.url === 'string' ? entry.url : '',
          event: entry.event,
          body: entry.body,
          status: typeof entry.status === 'number' ? entry.status : undefined,
          error: typeof entry.error === 'string' ? entry.error : undefined,
          attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
          failedAt: typeof entry.failedAt === 'string' ? entry.failedAt : new Date().toISOString(),
        });
      }
    }
  } catch {
    // No dead-letter store yet (or unreadable) — start empty.
  }
  // Drop anything that aged out while the process was down, then persist the
  // pruned set so disk does not carry expired entries forward.
  if (pruneExpiredDeadLetters()) persistDeadLetters();
}

// Best-effort persist. Fire-and-forget so add/remove keep their sync
// signatures; failures are logged, never thrown (mirrors the rest of the
// harness's append-only, non-fatal persistence). Secrets are stored in the
// clear like .harness/api-keys.json, so the file mode is locked to 0o600.
function persistWebhooks(): void {
  if (!storePath) return;
  const target = storePath;
  const snapshot = JSON.stringify(webhooks, null, 2);
  trackWrite(
    withFileLock(target, () => atomicWriteFile(target, snapshot, { encoding: 'utf-8', mode: 0o600 }))
      .catch((err) => logger.warn('Webhook', 'Persist failed', { error: err instanceof Error ? err.message : String(err) })),
  );
}

// Best-effort persist of the dead-letter queue. Mirrors persistWebhooks():
// fire-and-forget, 0o600 (the stored body may carry task/automation data),
// failures logged not thrown.
function persistDeadLetters(): void {
  if (!deadLetterStorePath) return;
  const target = deadLetterStorePath;
  const snapshot = JSON.stringify(deadLetters, null, 2);
  trackWrite(
    withFileLock(target, () => atomicWriteFile(target, snapshot, { encoding: 'utf-8', mode: 0o600 }))
      .catch((err) => logger.warn('Webhook', 'Dead-letter persist failed', { error: err instanceof Error ? err.message : String(err) })),
  );
}

// Persist (or refresh) a dead-letter entry for a delivery that gave up. When
// `existingId` is supplied (a redelivery that failed again) the matching entry
// is updated in place rather than duplicated.
function recordFailedDelivery(
  webhook: WebhookConfig,
  event: WebhookEventType,
  body: string,
  status: number | undefined,
  error: string | undefined,
  attempts: number,
  existingId?: string,
): void {
  const now = new Date().toISOString();
  if (existingId) {
    const entry = deadLetters.find((d) => d.id === existingId);
    if (entry) {
      entry.status = status;
      entry.error = error;
      entry.attempts = attempts;
      entry.failedAt = now;
      persistDeadLetters();
      return;
    }
  }
  deadLetters.unshift({
    id: `dl-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    webhookId: webhook.id,
    url: webhook.url,
    event,
    body,
    status,
    error,
    attempts,
    failedAt: now,
  });
  if (deadLetters.length > MAX_DEAD_LETTERS) deadLetters.length = MAX_DEAD_LETTERS;
  persistDeadLetters();
}

export function addWebhook(config: Omit<WebhookConfig, 'id'>): WebhookConfig {
  const id = `wh-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const webhook: WebhookConfig = { id, ...config };
  webhooks.push(webhook);
  persistWebhooks();
  return webhook;
}

export function removeWebhook(id: string): boolean {
  const idx = webhooks.findIndex((w) => w.id === id);
  if (idx === -1) return false;
  webhooks.splice(idx, 1);
  deliveryStatus.delete(id);
  deliveryHistory.delete(id);
  persistWebhooks();
  return true;
}

// Patch a webhook's enabled flag and/or event filter in place. Returns the
// updated config (secret redacted) or null for an unknown id. URL and secret
// are intentionally NOT editable here — changing those is a remove + re-add so
// stale delivery history / dead-letters never attach to a different endpoint.
export function updateWebhook(id: string, patch: { enabled?: boolean; events?: string[] }): (WebhookConfig & { lastDelivery?: WebhookDeliveryStatus }) | null {
  const webhook = webhooks.find((w) => w.id === id);
  if (!webhook) return null;
  if (typeof patch.enabled === 'boolean') webhook.enabled = patch.enabled;
  if (Array.isArray(patch.events)) webhook.events = patch.events.map(String);
  persistWebhooks();
  return { ...webhook, secret: webhook.secret ? '***' : undefined, lastDelivery: deliveryStatus.get(webhook.id) };
}

export function listWebhooks(): Array<WebhookConfig & { lastDelivery?: WebhookDeliveryStatus; recentDeliveries: WebhookDeliveryStatus[] }> {
  return webhooks.map((w) => ({
    ...w,
    secret: w.secret ? '***' : undefined,
    lastDelivery: deliveryStatus.get(w.id),
    recentDeliveries: deliveryHistory.get(w.id) ?? [],
  }));
}

/** List dead-lettered deliveries (newest first). The payload body is included
 * so callers can inspect what failed; no webhook secret is present here. Expired
 * entries are pruned first so the returned list never shows aged-out failures. */
export function listDeadLetters(): Array<WebhookDeadLetter & { ageMs: number }> {
  if (pruneExpiredDeadLetters()) persistDeadLetters();
  const now = Date.now();
  return deadLetters.map((d) => ({ ...d, ageMs: now - new Date(d.failedAt).getTime() }));
}

/**
 * Re-attempt a dead-lettered delivery against its still-configured webhook. On
 * success the entry is removed; on repeated failure it is refreshed in place.
 * Returns the outcome and a reason when it could not be attempted.
 */
export async function redeliverDeadLetter(id: string): Promise<{ ok: boolean; reason?: string }> {
  const entry = deadLetters.find((d) => d.id === id);
  if (!entry) return { ok: false, reason: 'not found' };
  const webhook = webhooks.find((w) => w.id === entry.webhookId);
  if (!webhook) return { ok: false, reason: 'webhook no longer configured' };
  const { ok } = await deliverWithRetry(webhook, entry.event, entry.body, { deadLetterId: entry.id });
  if (ok) {
    const idx = deadLetters.findIndex((d) => d.id === id);
    if (idx !== -1) deadLetters.splice(idx, 1);
    persistDeadLetters();
  }
  return { ok };
}

/** Drop a dead-lettered delivery without redelivering it. */
export function discardDeadLetter(id: string): boolean {
  const idx = deadLetters.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  deadLetters.splice(idx, 1);
  persistDeadLetters();
  return true;
}

/**
 * Fire a synthetic test ping at one configured webhook so a user can validate
 * the URL/secret before relying on it for real events. The outcome is NOT
 * recorded in delivery history and a failure does NOT dead-letter — a manual
 * test must never pollute the real timeline or the redelivery queue. Returns
 * the delivery outcome, or `reason: 'not found'` for an unknown id.
 */
export async function testWebhook(id: string): Promise<{ ok: boolean; status?: number; error?: string; reason?: string }> {
  const webhook = webhooks.find((w) => w.id === id);
  if (!webhook) return { ok: false, reason: 'not found' };
  const payload: WebhookPayload = {
    event: 'health.daily',
    timestamp: new Date().toISOString(),
    data: { test: true, message: 'Webhook test ping from Ollama Agent Harness' },
  };
  const result = await deliverWithRetry(webhook, 'health.daily', JSON.stringify(payload), { test: true });
  return { ok: result.ok, status: result.status, error: result.error };
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
      logger.info('Webhook', 'Loaded webhook from env', { url: redactWebhookUrl(url) });
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
    if ((await deliverWithRetry(webhook, event, body)).ok) sent++;
  }
  return sent;
}

// Record a delivery outcome: the latest status (for the lastDelivery badge) and
// a bounded, newest-first ring of recent outcomes (for the UI timeline / flap
// detection). Both are in-memory only.
function recordDelivery(webhookId: string, status: WebhookDeliveryStatus): void {
  deliveryStatus.set(webhookId, status);
  const history = deliveryHistory.get(webhookId) ?? [];
  history.unshift(status);
  if (history.length > MAX_DELIVERY_HISTORY) history.length = MAX_DELIVERY_HISTORY;
  deliveryHistory.set(webhookId, history);
}

// Deliver to a single webhook with bounded retry/backoff. Records the final
// outcome in deliveryStatus and returns whether it ultimately succeeded.
// Retries cover transient failures (network errors, 5xx); a 4xx is treated as
// a permanent client error and is not retried. A delivery that ultimately
// fails is dead-lettered for manual redelivery (pass opts.deadLetterId when
// redelivering so the existing entry is refreshed rather than duplicated).
// When opts.test is set, the outcome is neither recorded nor dead-lettered so
// a manual test ping cannot pollute the real timeline or the redelivery queue.
async function deliverWithRetry(webhook: WebhookConfig, event: WebhookEventType, body: string, opts: { deadLetterId?: string; test?: boolean } = {}): Promise<{ ok: boolean; status?: number; error?: string; attempts: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Webhook-Event': event };
  if (webhook.secret) {
    const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  const maxAttempts = retryDelaysMs.length + 1;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    try {
      const res = await fetch(webhook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        if (!opts.test) recordDelivery(webhook.id, { ok: true, status: res.status, attempts: attempt, at: new Date().toISOString(), event });
        logger.info('Webhook', 'Delivered', { event, url: redactWebhookUrl(webhook.url), status: res.status, attempt });
        return { ok: true, status: res.status, attempts: attempt };
      }
      lastStatus = res.status;
      lastError = undefined;
      // 4xx is a permanent client error (bad URL, auth, payload) — retrying wastes effort.
      if (res.status >= 400 && res.status < 500) {
        logger.warn('Webhook', 'Delivery failed (client error, not retried)', { event, url: redactWebhookUrl(webhook.url), status: res.status });
        break;
      }
      logger.warn('Webhook', 'Delivery failed', { event, url: redactWebhookUrl(webhook.url), status: res.status, attempt });
    } catch (err) {
      lastStatus = undefined;
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn('Webhook', 'Delivery error', { event, url: redactWebhookUrl(webhook.url), error: lastError, attempt });
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt - 1]));
    }
  }

  if (!opts.test) {
    recordDelivery(webhook.id, { ok: false, status: lastStatus, error: lastError, attempts: attemptsMade, at: new Date().toISOString(), event });
    recordFailedDelivery(webhook, event, body, lastStatus, lastError, attemptsMade, opts.deadLetterId);
  }
  return { ok: false, status: lastStatus, error: lastError, attempts: attemptsMade };
}
