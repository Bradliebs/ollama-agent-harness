import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addWebhook, discardDeadLetter, flushWebhookWritesForTest, initWebhookStore, listDeadLetters, listWebhooks, redeliverDeadLetter, removeWebhook, sendWebhookNotification, setDeadLetterMaxAgeForTest, setWebhookRetryDelaysForTest, testWebhook, updateWebhook } from './webhooks';

describe('webhook persistence', () => {
  let dir: string;
  let storeFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-test-'));
    fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
    storeFile = path.join(dir, '.harness', 'webhooks.json');
    // Seed an empty store so initWebhookStore() resets the shared in-memory
    // array to a clean slate for every test (it only clears on a parse hit).
    fs.writeFileSync(storeFile, '[]', 'utf-8');
    initWebhookStore(dir);
  });

  afterEach(async () => {
    await flushWebhookWritesForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // persistWebhooks() is fire-and-forget, so poll the file until the write lands.
  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for webhook store write');
  }

  function readStore(): Array<Record<string, unknown>> {
    return JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
  }

  it('persists an added webhook to disk including its secret', async () => {
    const wh = addWebhook({ url: 'https://example.test/hook', secret: 's3cr3t', events: ['task.added'], enabled: true });
    await waitFor(() => readStore().some((e) => e.id === wh.id));

    const onDisk = readStore().find((e) => e.id === wh.id);
    expect(onDisk).toMatchObject({ url: 'https://example.test/hook', secret: 's3cr3t', events: ['task.added'], enabled: true });
  });

  it('reloads persisted webhooks on a simulated restart', async () => {
    const wh = addWebhook({ url: 'https://example.test/reload', events: [], enabled: true });
    await waitFor(() => readStore().some((e) => e.id === wh.id));

    // Re-init from the same dir = restart. listWebhooks redacts secrets.
    initWebhookStore(dir);
    const reloaded = listWebhooks().find((w) => w.id === wh.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.url).toBe('https://example.test/reload');
  });

  it('redacts secrets from listWebhooks but keeps them on disk', async () => {
    const wh = addWebhook({ url: 'https://example.test/secret', secret: 'keepme', events: [], enabled: true });
    await waitFor(() => readStore().some((e) => e.id === wh.id));

    const listed = listWebhooks().find((w) => w.id === wh.id);
    expect(listed?.secret).toBe('***');
    expect(readStore().find((e) => e.id === wh.id)?.secret).toBe('keepme');
  });

  it('persists removals so they survive a restart', async () => {
    const a = addWebhook({ url: 'https://example.test/a', events: [], enabled: true });
    const b = addWebhook({ url: 'https://example.test/b', events: [], enabled: true });
    await waitFor(() => readStore().some((e) => e.id === b.id));

    expect(removeWebhook(a.id)).toBe(true);
    await waitFor(() => !readStore().some((e) => e.id === a.id));

    initWebhookStore(dir);
    const ids = listWebhooks().map((w) => w.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('skips malformed entries when loading', () => {
    fs.writeFileSync(
      storeFile,
      JSON.stringify([
        { id: 'good', url: 'https://example.test/good', events: [], enabled: true },
        { id: 123, url: 'https://example.test/bad-id' },
        { url: 'https://example.test/missing-id' },
        'not-an-object',
      ]),
      'utf-8',
    );
    initWebhookStore(dir);
    const ids = listWebhooks().map((w) => w.id);
    expect(ids).toEqual(['good']);
  });

  it('clears the in-memory registry when re-init finds no store file', () => {
    addWebhook({ url: 'https://example.test/stale', events: [], enabled: true });
    expect(listWebhooks().length).toBeGreaterThan(0);
    // Point at a dir with no webhooks.json: the registry must reset to empty,
    // not retain the prior project's webhooks (regression guard).
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-empty-'));
    try {
      initWebhookStore(empty);
      expect(listWebhooks()).toHaveLength(0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('updateWebhook toggles enabled and patches events, returning null for unknown ids', () => {
    const wh = addWebhook({ url: 'https://example.test/patch', events: ['task.added'], enabled: true });
    const disabled = updateWebhook(wh.id, { enabled: false });
    expect(disabled).toMatchObject({ id: wh.id, enabled: false });
    const patched = updateWebhook(wh.id, { events: ['email.sent', 'health.daily'] });
    expect(patched?.events).toEqual(['email.sent', 'health.daily']);
    expect(listWebhooks().find((w) => w.id === wh.id)).toMatchObject({ enabled: false, events: ['email.sent', 'health.daily'] });
    expect(updateWebhook('nope', { enabled: true })).toBeNull();
  });

  it('does not deliver to a disabled webhook', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue({ ok: true, status: 200 } as never);
    try {
      const wh = addWebhook({ url: 'https://example.test/off', events: [], enabled: true });
      updateWebhook(wh.id, { enabled: false });
      const sent = await sendWebhookNotification('task.added', {});
      expect(sent).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (fetchSpy as jest.SpyInstance).mockRestore();
    }
  });

  // POSIX permission bits are only meaningful off Windows.
  (process.platform === 'win32' ? it.skip : it)('writes the store with 0600 permissions', async () => {
    const wh = addWebhook({ url: 'https://example.test/mode', secret: 'x', events: [], enabled: true });
    await waitFor(() => readStore().some((e) => e.id === wh.id));
    expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600);
  });
});

describe('webhook delivery retry & status', () => {
  let dir: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-deliver-'));
    fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.harness', 'webhooks.json'), '[]', 'utf-8');
    initWebhookStore(dir);
    setWebhookRetryDelaysForTest([0, 0]); // 3 attempts, no real backoff wait
  });

  afterEach(async () => {
    setWebhookRetryDelaysForTest([500, 2000]);
    fetchSpy?.mockRestore();
    await flushWebhookWritesForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mockFetch(impl: (attempt: number) => { ok: boolean; status: number } | Error): void {
    let attempt = 0;
    fetchSpy = jest.spyOn(global, 'fetch' as never).mockImplementation((async () => {
      attempt += 1;
      const result = impl(attempt);
      if (result instanceof Error) throw result;
      return { ok: result.ok, status: result.status } as Response;
    }) as never);
  }

  it('records success on the first attempt', async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    const wh = addWebhook({ url: 'https://example.test/ok', events: [], enabled: true });
    const sent = await sendWebhookNotification('task.added', {});
    expect(sent).toBe(1);
    const status = listWebhooks().find((w) => w.id === wh.id)?.lastDelivery;
    expect(status).toMatchObject({ ok: true, status: 200, attempts: 1, event: 'task.added' });
  });

  it('retries transient failures and succeeds on a later attempt', async () => {
    mockFetch((attempt) => (attempt < 2 ? new Error('ECONNREFUSED') : { ok: true, status: 200 }));
    const wh = addWebhook({ url: 'https://example.test/flaky', events: [], enabled: true });
    const sent = await sendWebhookNotification('task.added', {});
    expect(sent).toBe(1);
    expect(listWebhooks().find((w) => w.id === wh.id)?.lastDelivery).toMatchObject({ ok: true, attempts: 2 });
  });

  it('exhausts all attempts on persistent failure and records ok:false', async () => {
    mockFetch(() => new Error('network down'));
    const wh = addWebhook({ url: 'https://example.test/dead', events: [], enabled: true });
    const sent = await sendWebhookNotification('task.added', {});
    expect(sent).toBe(0);
    const status = listWebhooks().find((w) => w.id === wh.id)?.lastDelivery;
    expect(status).toMatchObject({ ok: false, attempts: 3, error: 'network down' });
  });

  it('does not retry 4xx client errors', async () => {
    mockFetch(() => ({ ok: false, status: 404 }));
    const wh = addWebhook({ url: 'https://example.test/gone', events: [], enabled: true });
    const sent = await sendWebhookNotification('task.added', {});
    expect(sent).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listWebhooks().find((w) => w.id === wh.id)?.lastDelivery).toMatchObject({ ok: false, status: 404, attempts: 1 });
  });

  it('skips disabled webhooks and event-filtered webhooks', async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    addWebhook({ url: 'https://example.test/disabled', events: [], enabled: false });
    addWebhook({ url: 'https://example.test/other-event', events: ['email.sent'], enabled: true });
    const sent = await sendWebhookNotification('task.added', {});
    expect(sent).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a bounded, newest-first ring of recent deliveries', async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    const wh = addWebhook({ url: 'https://example.test/ring', events: [], enabled: true });
    for (let i = 0; i < 12; i++) await sendWebhookNotification('task.added', { i });
    // Final send with a distinct status proves newest-first ordering.
    fetchSpy.mockRestore();
    mockFetch(() => ({ ok: true, status: 202 }));
    await sendWebhookNotification('task.added', {});
    const recent = listWebhooks().find((w) => w.id === wh.id)?.recentDeliveries ?? [];
    expect(recent).toHaveLength(10); // capped at MAX_DELIVERY_HISTORY
    expect(recent[0].status).toBe(202); // newest first
  });

  it('testWebhook delivers a ping without recording history or dead-lettering', async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    const wh = addWebhook({ url: 'https://example.test/ping', events: [], enabled: true });
    const result = await testWebhook(wh.id);
    expect(result).toMatchObject({ ok: true, status: 200 });
    // A test ping must not surface in the real timeline or last-delivery badge.
    const listed = listWebhooks().find((w) => w.id === wh.id);
    expect(listed?.lastDelivery).toBeUndefined();
    expect(listed?.recentDeliveries).toHaveLength(0);
    expect(listDeadLetters()).toHaveLength(0);
  });

  it('testWebhook reports a failing endpoint without dead-lettering it', async () => {
    mockFetch(() => ({ ok: false, status: 500 }));
    const wh = addWebhook({ url: 'https://example.test/down', events: [], enabled: true });
    const result = await testWebhook(wh.id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(listDeadLetters()).toHaveLength(0); // tests never dead-letter
  });

  it('testWebhook returns not-found for an unknown id', async () => {
    const result = await testWebhook('nope');
    expect(result).toEqual({ ok: false, reason: 'not found' });
  });
});

describe('webhook dead-letter & redelivery', () => {
  let dir: string;
  let deadLetterFile: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-dl-'));
    fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.harness', 'webhooks.json'), '[]', 'utf-8');
    deadLetterFile = path.join(dir, '.harness', 'webhook-deadletter.json');
    initWebhookStore(dir); // clears the shared registry and dead-letter queue
    setWebhookRetryDelaysForTest([0, 0]); // 3 attempts, no real backoff wait
  });

  afterEach(async () => {
    setWebhookRetryDelaysForTest([500, 2000]);
    fetchSpy?.mockRestore();
    await flushWebhookWritesForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Single sequential fetch mock shared across every delivery in a test, so the
  // attempt counter spans both the initial send and any later redelivery.
  function mockFetch(impl: (attempt: number) => { ok: boolean; status: number } | Error): void {
    let attempt = 0;
    fetchSpy = jest.spyOn(global, 'fetch' as never).mockImplementation((async () => {
      attempt += 1;
      const result = impl(attempt);
      if (result instanceof Error) throw result;
      return { ok: result.ok, status: result.status } as Response;
    }) as never);
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for dead-letter write');
  }

  it('dead-letters a delivery that exhausts all retries, retaining the payload', async () => {
    mockFetch(() => new Error('network down'));
    const wh = addWebhook({ url: 'https://example.test/dead', events: [], enabled: true });
    await sendWebhookNotification('task.added', { foo: 1 });
    const dead = listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ webhookId: wh.id, event: 'task.added', attempts: 3, error: 'network down' });
    expect(JSON.parse(dead[0].body)).toMatchObject({ event: 'task.added', data: { foo: 1 } });
  });

  it('dead-letters a permanent 4xx without retrying', async () => {
    mockFetch(() => ({ ok: false, status: 404 }));
    addWebhook({ url: 'https://example.test/gone', events: [], enabled: true });
    await sendWebhookNotification('task.added', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listDeadLetters()[0]).toMatchObject({ status: 404, attempts: 1 });
  });

  it('persists dead-letters to disk with no webhook secret', async () => {
    mockFetch(() => new Error('down'));
    addWebhook({ url: 'https://example.test/dead', secret: 's3cr3t', events: [], enabled: true });
    await sendWebhookNotification('task.added', {});
    await waitFor(() => fs.existsSync(deadLetterFile));
    const onDisk = JSON.parse(fs.readFileSync(deadLetterFile, 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).not.toHaveProperty('secret');
  });

  it('redelivers a dead-letter on success and clears the entry', async () => {
    // First 3 attempts fail (initial send exhausts retries); attempt 4 succeeds.
    mockFetch((attempt) => (attempt <= 3 ? new Error('down') : { ok: true, status: 200 }));
    addWebhook({ url: 'https://example.test/flaky', events: [], enabled: true });
    await sendWebhookNotification('task.added', {});
    const entry = listDeadLetters()[0];
    expect(entry).toBeDefined();
    const result = await redeliverDeadLetter(entry.id);
    expect(result.ok).toBe(true);
    expect(listDeadLetters()).toHaveLength(0);
  });

  it('refuses to redeliver when the webhook is no longer configured', async () => {
    mockFetch(() => new Error('down'));
    const wh = addWebhook({ url: 'https://example.test/dead', events: [], enabled: true });
    await sendWebhookNotification('task.added', {});
    const entry = listDeadLetters()[0];
    removeWebhook(wh.id);
    const result = await redeliverDeadLetter(entry.id);
    expect(result).toEqual({ ok: false, reason: 'webhook no longer configured' });
    expect(listDeadLetters()).toHaveLength(1); // retained, not lost
  });

  it('discards a dead-letter entry', async () => {
    mockFetch(() => new Error('down'));
    addWebhook({ url: 'https://example.test/dead', events: [], enabled: true });
    await sendWebhookNotification('task.added', {});
    const entry = listDeadLetters()[0];
    expect(discardDeadLetter(entry.id)).toBe(true);
    expect(listDeadLetters()).toHaveLength(0);
    expect(discardDeadLetter('nope')).toBe(false);
  });

  it('prunes dead-letters older than the age cap and reports age', async () => {
    mockFetch(() => new Error('down'));
    addWebhook({ url: 'https://example.test/dead', events: [], enabled: true });
    await sendWebhookNotification('task.added', {});
    const listed = listDeadLetters();
    expect(listed[0].ageMs).toBeGreaterThanOrEqual(0);
    // Age cap of -1ms makes every existing entry expired on the next list.
    setDeadLetterMaxAgeForTest(-1);
    try {
      expect(listDeadLetters()).toHaveLength(0);
    } finally {
      setDeadLetterMaxAgeForTest(7 * 24 * 60 * 60 * 1000);
    }
  });
});
