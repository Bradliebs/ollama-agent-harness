import type { AddressInfo } from 'net';
import * as fs from 'fs';
import http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  addWebhook,
  initWebhookStore,
  listDeadLetters,
  removeWebhook,
  sendWebhookNotification,
  setWebhookRetryDelaysForTest,
} from '../integrations/webhooks';
import { app, drainChatBackgroundTasksForTest, stopUploadsAutoPrune } from './server';

jest.setTimeout(30_000);

describe('webhook dead-letter route API', () => {
  let server: http.Server;
  let baseUrl: string;
  // Target the webhook fires at. Its status code is mutable so a test can make
  // the initial delivery fail (seeding a dead-letter) and a later redelivery
  // succeed, all over real fetch (no global mock that would also intercept the
  // test's own requests to the harness server).
  let target: http.Server;
  let targetUrl: string;
  let targetStatus = 500;
  let storeDir: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    target = http.createServer((_req, res) => { res.statusCode = targetStatus; res.end(); });
    await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', () => resolve()); });
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await drainChatBackgroundTasksForTest();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    await new Promise<void>((resolve, reject) => target.close((e) => e ? reject(e) : resolve()));
    stopUploadsAutoPrune();
    setWebhookRetryDelaysForTest([500, 2000]);
  });

  beforeEach(() => {
    // Point the shared registry + dead-letter queue at a fresh temp dir so each
    // test starts empty and never reloads a prior test's persisted entries.
    // Seed an empty store file so initWebhookStore() resets the shared in-memory
    // arrays (it only clears on a successful parse, mirroring the unit tests).
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-routes-'));
    fs.mkdirSync(path.join(storeDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(storeDir, '.harness', 'webhooks.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(storeDir, '.harness', 'webhook-deadletter.json'), '[]', 'utf-8');
    initWebhookStore(storeDir);
    setWebhookRetryDelaysForTest([0, 0]); // 3 attempts, no backoff wait
    targetStatus = 500;
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  // Seed exactly one dead-letter by firing a notification at a webhook whose
  // target currently returns 500. Returns the seeded entry id.
  async function seedDeadLetter(): Promise<{ id: string; webhookId: string }> {
    const wh = addWebhook({ url: targetUrl, events: [], enabled: true });
    await sendWebhookNotification('task.added', { seeded: true });
    const entry = listDeadLetters()[0];
    if (!entry) throw new Error('failed to seed dead-letter');
    return { id: entry.id, webhookId: wh.id };
  }

  it('lists dead-letters via GET /api/webhooks/dead-letter', async () => {
    await seedDeadLetter();
    const res = await fetch(`${baseUrl}/api/webhooks/dead-letter`);
    expect(res.status).toBe(200);
    const body = await res.json() as { deadLetters: Array<{ event: string; ageMs: number }> };
    expect(body.deadLetters).toHaveLength(1);
    expect(body.deadLetters[0]).toMatchObject({ event: 'task.added' });
    expect(body.deadLetters[0].ageMs).toBeGreaterThanOrEqual(0);
  });

  it('redelivers successfully and clears the entry (200)', async () => {
    const { id } = await seedDeadLetter();
    targetStatus = 200; // next delivery succeeds
    const res = await fetch(`${baseUrl}/api/webhooks/dead-letter/${id}/redeliver`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(listDeadLetters()).toHaveLength(0);
  });

  it('returns 404 redelivering an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/dead-letter/nope/redeliver`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the webhook was removed', async () => {
    const { id, webhookId } = await seedDeadLetter();
    removeWebhook(webhookId);
    const res = await fetch(`${baseUrl}/api/webhooks/dead-letter/${id}/redeliver`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(listDeadLetters()).toHaveLength(1); // retained, not lost
  });

  it('returns 502 when the redelivery still fails', async () => {
    const { id } = await seedDeadLetter();
    // target still returns 500
    const res = await fetch(`${baseUrl}/api/webhooks/dead-letter/${id}/redeliver`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(listDeadLetters()).toHaveLength(1); // refreshed, not removed
  });

  it('discards a dead-letter via DELETE (200) and 404s an unknown id', async () => {
    const { id } = await seedDeadLetter();
    const ok = await fetch(`${baseUrl}/api/webhooks/dead-letter/${id}`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(listDeadLetters()).toHaveLength(0);
    const missing = await fetch(`${baseUrl}/api/webhooks/dead-letter/nope`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('test-pings a configured webhook (200) and reports failure (502) without dead-lettering', async () => {
    targetStatus = 200;
    const wh = addWebhook({ url: targetUrl, events: [], enabled: true });
    const ok = await fetch(`${baseUrl}/api/webhooks/${wh.id}/test`, { method: 'POST' });
    expect(ok.status).toBe(200);
    targetStatus = 500;
    const fail = await fetch(`${baseUrl}/api/webhooks/${wh.id}/test`, { method: 'POST' });
    expect(fail.status).toBe(502);
    expect(listDeadLetters()).toHaveLength(0); // a test ping never dead-letters
  });

  it('returns 404 test-pinging an unknown webhook', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/nope/test`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('patches enabled/events via PATCH and 404s an unknown id', async () => {
    const wh = addWebhook({ url: targetUrl, events: ['task.added'], enabled: true });
    const res = await fetch(`${baseUrl}/api/webhooks/${wh.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, events: ['email.sent'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { webhook: { enabled: boolean; events: string[] } };
    expect(body.webhook).toMatchObject({ enabled: false, events: ['email.sent'] });
    const missing = await fetch(`${baseUrl}/api/webhooks/nope`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });
});
