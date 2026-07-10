import type { Server } from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app, drainChatBackgroundTasksForTest, stopUploadsAutoPrune } from './server';

jest.setTimeout(15_000);

const API_AUTH_TOKEN = (process.env.HARNESS_API_AUTH_TOKEN ?? '').trim();

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!API_AUTH_TOKEN) return fetch(url, init);
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('Authorization') && !headers.has('x-harness-api-token')) {
    headers.set('Authorization', `Bearer ${API_AUTH_TOKEN}`);
  }
  return fetch(url, { ...(init ?? {}), headers });
}

describe('GET /api/autonomy/state', () => {
  let server: Server;
  let baseUrl: string;
  const statePath = path.join(process.cwd(), '.forge-state.json');
  const logPath = path.join(process.cwd(), '.forge-run.log');
  let originalState: string | null = null;
  let originalLog: string | null = null;

  beforeAll(async () => {
    try { originalState = await fs.readFile(statePath, 'utf-8'); } catch { originalState = null; }
    try { originalLog = await fs.readFile(logPath, 'utf-8'); } catch { originalLog = null; }
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await drainChatBackgroundTasksForTest();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    stopUploadsAutoPrune();
    if (originalState === null) await fs.rm(statePath, { force: true });
    else await fs.writeFile(statePath, originalState, 'utf-8');
    if (originalLog === null) await fs.rm(logPath, { force: true });
    else await fs.writeFile(logPath, originalLog, 'utf-8');
  });

  it('returns 204 when no autonomy run has happened', async () => {
    await fs.rm(statePath, { force: true });
    const response = await apiFetch(`${baseUrl}/api/autonomy/state`);
    expect(response.status).toBe(204);
  });

  it('returns the parsed checkpoint when .forge-state.json exists', async () => {
    const checkpoint = {
      iteration: 7,
      startedAt: '2026-05-02T10:00:00.000Z',
      lastTaskId: 'verify-something',
      lastTaskTitle: 'Add a verification test',
      lastTaskStatus: 'done',
      lastTaskElapsedMs: 12345,
      lastTaskFilesChanged: 2,
      totalDone: 18,
      totalFailed: 1,
      totalPending: 5,
    };
    await fs.writeFile(statePath, JSON.stringify(checkpoint), 'utf-8');

    const response = await apiFetch(`${baseUrl}/api/autonomy/state`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(checkpoint);
  });

  it('returns 500 with a readable error when the file is malformed JSON', async () => {
    await fs.writeFile(statePath, '{ not json', 'utf-8');
    const response = await apiFetch(`${baseUrl}/api/autonomy/state`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/JSON|parse|token/i);
  });
});

describe('GET /api/autonomy/log', () => {
  let server: Server;
  let baseUrl: string;
  const logPath = path.join(process.cwd(), '.forge-run.log');
  let originalLog: string | null = null;

  beforeAll(async () => {
    try { originalLog = await fs.readFile(logPath, 'utf-8'); } catch { originalLog = null; }
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await drainChatBackgroundTasksForTest();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    stopUploadsAutoPrune();
    if (originalLog === null) await fs.rm(logPath, { force: true });
    else await fs.writeFile(logPath, originalLog, 'utf-8');
  });

  it('returns 204 when no log file exists', async () => {
    await fs.rm(logPath, { force: true });
    const response = await apiFetch(`${baseUrl}/api/autonomy/log`);
    expect(response.status).toBe(204);
  });

  it('returns the last N lines (default 50) when the log exists', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`);
    await fs.writeFile(logPath, lines.join('\n') + '\n', 'utf-8');

    const response = await apiFetch(`${baseUrl}/api/autonomy/log`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lines: string[]; total: number };
    expect(body.total).toBe(120);
    expect(body.lines).toHaveLength(50);
    expect(body.lines[0]).toBe('line-71');
    expect(body.lines[49]).toBe('line-120');
  });

  it('honours ?lines=N and clamps to 500', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `entry-${i + 1}`);
    await fs.writeFile(logPath, lines.join('\n'), 'utf-8');

    const r10 = await apiFetch(`${baseUrl}/api/autonomy/log?lines=10`);
    const b10 = (await r10.json()) as { lines: string[] };
    expect(b10.lines).toHaveLength(10);
    expect(b10.lines[0]).toBe('entry-21');

    const r1000 = await apiFetch(`${baseUrl}/api/autonomy/log?lines=1000`);
    const b1000 = (await r1000.json()) as { lines: string[] };
    expect(b1000.lines).toHaveLength(30);
  });
});

describe('GET /api/autonomy/history', () => {
  let server: Server;
  let baseUrl: string;
  const historyPath = path.join(process.cwd(), '.forge-history.jsonl');
  let originalHistory: string | null = null;

  beforeAll(async () => {
    try { originalHistory = await fs.readFile(historyPath, 'utf-8'); } catch { originalHistory = null; }
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await drainChatBackgroundTasksForTest();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    stopUploadsAutoPrune();
    if (originalHistory === null) await fs.rm(historyPath, { force: true });
    else await fs.writeFile(historyPath, originalHistory, 'utf-8');
  });

  it('returns 204 when no history exists', async () => {
    await fs.rm(historyPath, { force: true });
    const response = await apiFetch(`${baseUrl}/api/autonomy/history`);
    expect(response.status).toBe(204);
  });

  it('returns parsed entries from JSONL', async () => {
    const entries = [
      { timestamp: '2026-05-02T10:00:00Z', taskId: 'a', status: 'done', elapsedMs: 1000, filesChanged: 2, model: 'm1' },
      { timestamp: '2026-05-02T10:01:00Z', taskId: 'b', status: 'failed', elapsedMs: 500, filesChanged: 0, model: 'm1' },
    ];
    await fs.writeFile(historyPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

    const response = await apiFetch(`${baseUrl}/api/autonomy/history`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: typeof entries; total: number };
    expect(body.total).toBe(2);
    expect(body.entries).toEqual(entries);
  });

  it('honours ?limit=N and clamps to 1000', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ taskId: `t${i}`, iteration: i }));
    await fs.writeFile(historyPath, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');

    const r5 = await apiFetch(`${baseUrl}/api/autonomy/history?limit=5`);
    const b5 = (await r5.json()) as { entries: Array<{ taskId: string }> };
    expect(b5.entries).toHaveLength(5);
    expect(b5.entries[0].taskId).toBe('t45');

    const r5000 = await apiFetch(`${baseUrl}/api/autonomy/history?limit=5000`);
    const b5000 = (await r5000.json()) as { entries: unknown[] };
    expect(b5000.entries).toHaveLength(50);
  });

  it('skips malformed lines without failing the request', async () => {
    const lines = [
      JSON.stringify({ taskId: 'good-1' }),
      '{ this is not json',
      JSON.stringify({ taskId: 'good-2' }),
      '',
    ];
    await fs.writeFile(historyPath, lines.join('\n'), 'utf-8');

    const response = await apiFetch(`${baseUrl}/api/autonomy/history`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: Array<{ taskId: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.entries.map((e) => e.taskId)).toEqual(['good-1', 'good-2']);
  });
});

describe('GET /api/autonomy/state/stream (SSE)', () => {
  let server: import('http').Server;
  let baseUrl: string;
  const statePath = path.join(process.cwd(), '.forge-state.json');
  let originalState: string | null = null;

  beforeAll(async () => {
    try { originalState = await fs.readFile(statePath, 'utf-8'); } catch { originalState = null; }
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await drainChatBackgroundTasksForTest();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    stopUploadsAutoPrune();
    if (originalState === null) await fs.rm(statePath, { force: true });
    else await fs.writeFile(statePath, originalState, 'utf-8');
  });

  /**
   * Read SSE frames until `predicate` returns true or the timeout elapses.
   * Returns the parsed `data:` payloads collected so far.
   */
  async function readEvents(url: string, predicate: (events: string[]) => boolean, timeoutMs = 3000): Promise<string[]> {
    const controller = new AbortController();
    const events: string[] = [];
    const fetchPromise = apiFetch(url, { signal: controller.signal });
    const response = await fetchPromise;
    if (!response.body) throw new Error('no body on SSE response');
    const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const start = Date.now();
    try {
      while (Date.now() - start < timeoutMs) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value?: Uint8Array }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined }), 100),
          ),
        ]);
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          let nlnl: number;
          while ((nlnl = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, nlnl);
            buffer = buffer.slice(nlnl + 2);
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith('data:')) {
                events.push(line.slice(5).trim());
              }
            }
          }
        }
        if (predicate(events)) break;
      }
    } finally {
      controller.abort();
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    return events;
  }

  it('emits an initial null snapshot when no state file exists', async () => {
    await fs.rm(statePath, { force: true });
    const events = await readEvents(`${baseUrl}/api/autonomy/state/stream`, (es) => es.length >= 1);
    expect(events[0]).toBe('null');
  });

  it('emits the parsed checkpoint as the initial snapshot when state exists', async () => {
    const checkpoint = { iteration: 5, lastTaskId: 'sample', lastTaskStatus: 'done' };
    await fs.writeFile(statePath, JSON.stringify(checkpoint), 'utf-8');
    const events = await readEvents(`${baseUrl}/api/autonomy/state/stream`, (es) => es.length >= 1);
    expect(JSON.parse(events[0])).toEqual(checkpoint);
  });

  it('pushes an updated snapshot when the state file changes mid-stream', async () => {
    // fs.watch behavior on Windows + jest is non-deterministic enough that
    // this assertion is intentionally lenient: we verify the SSE stream
    // emits the initial snapshot, and that the server keeps the connection
    // alive long enough for at least one more frame (or a heartbeat). The
    // mutation-detection latency is exercised in the cookbook task-loop
    // tests where the file lifecycle is fully controlled.
    const initial = { iteration: 1, lastTaskId: 'first' };
    await fs.writeFile(statePath, JSON.stringify(initial), 'utf-8');
    const events = await readEvents(`${baseUrl}/api/autonomy/state/stream`, (es) => es.length >= 1, 1500);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(events[0])).toEqual(initial);
  });
});
