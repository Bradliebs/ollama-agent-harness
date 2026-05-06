import { PassThrough } from 'stream';
import { createTuiClient } from './client';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  private listeners = new Map<string, Array<(arg: unknown) => void>>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  on(event: string, listener: (arg: unknown) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
  }
  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
  close() {
    this.closed = true;
    this.emit('close', undefined);
  }
}

function makeStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // readline interface checks `isTTY` to decide on cursor handling. Force
  // false so the prompt() calls don't try to manipulate a fake TTY.
  Object.assign(stdin, { isTTY: false });
  Object.assign(stdout, { isTTY: false, columns: 80 });
  return { stdin, stdout };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('createTuiClient', () => {
  beforeEach(() => { FakeWebSocket.instances = []; });

  it('seeds the transcript with a connection message', () => {
    const { stdin, stdout } = makeStreams();
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ subagents: [] })) as unknown as typeof fetch;
    const client = createTuiClient({
      baseUrl: 'http://daemon.example',
      stdin,
      stdout,
      fetchImpl,
      webSocketImpl: FakeWebSocket as unknown as typeof import('ws').WebSocket,
      useColor: false,
    });
    const transcript = client.getTranscript();
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript[transcript.length - 1].role).toBe('system');
    expect(transcript[transcript.length - 1].text).toContain('Connected');
    return client.stop();
  });

  it('opens a WebSocket against the matching ws:// URL', () => {
    const { stdin, stdout } = makeStreams();
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ subagents: [] })) as unknown as typeof fetch;
    const client = createTuiClient({
      baseUrl: 'http://daemon.example',
      stdin,
      stdout,
      fetchImpl,
      webSocketImpl: FakeWebSocket as unknown as typeof import('ws').WebSocket,
      useColor: false,
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://daemon.example/ws');
    return client.stop();
  });

  it('refreshes active sub-agents when a subagent.start event arrives', async () => {
    const { stdin, stdout } = makeStreams();
    const responses: Response[] = [
      jsonResponse({ subagents: [] }),
      jsonResponse({ subagents: [{ id: 'r1', name: 'researcher', durationMs: 200 }] }),
    ];
    const fetchImpl = jest.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/subagents')) return responses.shift() ?? jsonResponse({ subagents: [] });
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const client = createTuiClient({
      baseUrl: 'http://daemon.example',
      stdin,
      stdout,
      fetchImpl,
      webSocketImpl: FakeWebSocket as unknown as typeof import('ws').WebSocket,
      useColor: false,
    });
    // Initial refresh consumed the first response.
    await new Promise((resolve) => setImmediate(resolve));
    FakeWebSocket.instances[0].emit('message', JSON.stringify({ type: 'event', event: { category: 'system', type: 'subagent.start', data: {} } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.getActiveSubagents()).toEqual([{ id: 'r1', name: 'researcher', durationMs: 200 }]);
    return client.stop();
  });

  it('streams /api/chat SSE responses into transcript entries', async () => {
    const { stdin, stdout } = makeStreams();
    const sseBody = [
      'data: {"type":"text","content":"hello "}',
      '',
      'data: {"type":"text","content":"world"}',
      '',
      'data: {"type":"done"}',
      '',
      '',
    ].join('\n');
    const sseResponse = new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const fetchImpl = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/subagents')) return jsonResponse({ subagents: [] });
      if (url.endsWith('/api/chat') && init?.method === 'POST') return sseResponse;
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const client = createTuiClient({
      baseUrl: 'http://daemon.example',
      stdin,
      stdout,
      fetchImpl,
      webSocketImpl: FakeWebSocket as unknown as typeof import('ws').WebSocket,
      useColor: false,
    });
    await client.send('say hi');
    const roles = client.getTranscript().map((entry) => entry.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    const assistant = client.getTranscript().filter((entry) => entry.role === 'assistant').pop();
    expect(assistant?.text).toBe('hello world');
    return client.stop();
  });

  it('records an error entry when the daemon is unreachable', async () => {
    const { stdin, stdout } = makeStreams();
    const fetchImpl = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/subagents')) return jsonResponse({ subagents: [] });
      if (url.endsWith('/api/chat') && init?.method === 'POST') throw new Error('ECONNREFUSED');
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const client = createTuiClient({
      baseUrl: 'http://daemon.example',
      stdin,
      stdout,
      fetchImpl,
      webSocketImpl: FakeWebSocket as unknown as typeof import('ws').WebSocket,
      useColor: false,
    });
    await client.send('hello');
    const errors = client.getTranscript().filter((entry) => entry.role === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toMatch(/ECONNREFUSED|Failed to reach daemon/);
    return client.stop();
  });
});
