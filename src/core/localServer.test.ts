import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { createChatClient } from './chatClientFactory';
import { OpenAIClient } from './openaiClient';
import { createLocalServerClient, getLocalServerContextWindow, isLoopbackServer, listLocalServerModels, localServerModelName, resetLocalServerCache } from './localServer';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

describe('local OpenAI-compatible server backend', () => {
  let server: Server;
  let handler: Handler;
  const requests: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: body ? JSON.parse(body) : {}, auth: req.headers.authorization });
        handler(req, body, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  beforeEach(() => {
    requests.length = 0;
    resetLocalServerCache();
    process.env = { ...savedEnv };
    delete process.env.HARNESS_LOCAL_CONTEXT_WINDOW;
    delete process.env.HARNESS_LOCAL_API_KEY;
    delete process.env.HARNESS_LOCAL_TIMEOUT_MS;
    process.env.HARNESS_LOCAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => { process.env = savedEnv; });

  const json = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const sse = (res: ServerResponse, frames: unknown[], delayMs = 5): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const next = (): void => {
      if (i < frames.length) { res.write(`data: ${JSON.stringify(frames[i++])}\n\n`); setTimeout(next, delayMs); return; }
      res.end('data: [DONE]\n\n');
    };
    next();
  };

  it('lists the models the server reports, and nothing when it is not running', async () => {
    handler = (req, _body, res) => json(res, 200, { object: 'list', data: [{ id: 'qwen3.8-flash-next' }, { id: 'qwen3.8-flash-next' }, { id: '' }] });
    expect(await listLocalServerModels()).toEqual(['qwen3.8-flash-next']);
    process.env.HARNESS_LOCAL_BASE_URL = 'http://127.0.0.1:1/v1';
    expect(await listLocalServerModels()).toEqual([]);
  });

  it('takes the context window from the setting, then /props, then a 32K default', async () => {
    handler = (req, _body, res) => (req.url === '/props' ? json(res, 200, { default_generation_settings: { n_ctx: 131072 } }) : json(res, 404, {}));
    expect(await getLocalServerContextWindow()).toBe(131072);
    process.env.HARNESS_LOCAL_CONTEXT_WINDOW = '65536';
    expect(await getLocalServerContextWindow()).toBe(65536);
    delete process.env.HARNESS_LOCAL_CONTEXT_WINDOW;
    // A server that stops answering (busy reading a prompt) keeps its last value.
    handler = (_req, _body, res) => json(res, 404, {});
    expect(await getLocalServerContextWindow()).toBe(131072);
    resetLocalServerCache();
    expect(await getLocalServerContextWindow()).toBe(32768);
  });

  it('is a local client that needs no API key, and reads a plain JSON answer to a streamed request', async () => {
    handler = (_req, _body, res) => json(res, 200, { choices: [{ message: { role: 'assistant', content: 'hi there' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    const client = createChatClient({ backend: 'local', model: 'qwen3.8-flash-next' });
    expect(client.getLocality?.()).toBe('local');
    const result = await client.chat([{ role: 'user', content: 'hello' }]);
    expect(result.message.content).toBe('hi there');
    // Local clients always stream (silence-based timeout); this server ignored it.
    expect(requests[0]).toMatchObject({ url: '/v1/chat/completions', body: { model: 'qwen3.8-flash-next', stream: true } });
    expect(requests[0].auth).toBe('Bearer local');
  });

  it('streams when a preview is wanted, reporting the text so far and joining tool-call fragments', async () => {
    handler = (_req, _body, res) => sse(res, [
      { choices: [{ delta: { role: 'assistant', content: 'Let me ' } }] },
      { choices: [{ delta: { content: 'check.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'file_read', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } },
    ]);
    process.env.HARNESS_LOCAL_API_KEY = 'secret';
    const seen: string[] = [];
    const client = createLocalServerClient('qwen');
    const tools = [{ type: 'function', function: { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} } } }];
    const result = await client.chat([{ role: 'user', content: 'read a.ts' }], tools as never, undefined, { onContent: (text) => seen.push(text) });
    expect(seen).toEqual(['Let me ', 'Let me check.']);
    expect(result.message.content).toBe('Let me check.');
    expect(result.message.tool_calls?.[0]).toMatchObject({ id: 'call_1', function: { name: 'file_read', arguments: { path: 'a.ts' } } });
    expect(result.usage).toMatchObject({ promptTokens: 40, completionTokens: 9 });
    expect(requests[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(requests[0].auth).toBe('Bearer secret');
  });

  it('reports an error sent inside the stream', async () => {
    handler = (_req, _body, res) => sse(res, [
      { choices: [{ delta: { content: 'partial' } }] },
      { error: { message: 'the request exceeds the available context size' } },
    ]);
    const client = createLocalServerClient('qwen');
    await expect(client.chat([{ role: 'user', content: 'x' }], undefined, undefined, { onContent: () => undefined }))
      .rejects.toThrow('Local server stream error: the request exceeds the available context size');
  });

  it('gives up after a silence longer than the timeout, not after a long reply', async () => {
    process.env.HARNESS_LOCAL_TIMEOUT_MS = '300';
    // Six chunks 100 ms apart (600 ms in all) keep the stream alive.
    handler = (_req, _body, res) => sse(res, Array.from({ length: 6 }, (_, i) => ({ choices: [{ delta: { content: String(i) } }] })), 100);
    const ok = await createLocalServerClient('qwen').chat([{ role: 'user', content: 'x' }], undefined, undefined, { onContent: () => undefined });
    expect(ok.message.content).toBe('012345');
    // Then a server that goes quiet after the headers.
    handler = (_req, _body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': loading\n\n'); setTimeout(() => res.end(), 1_500); };
    await expect(createLocalServerClient('qwen').chat([{ role: 'user', content: 'x' }], undefined, undefined, { onContent: () => undefined }))
      .rejects.toThrow('no output for 0s');
  });

  it('leaves cloud providers unstreamed even when a preview is asked for', async () => {
    handler = (_req, _body, res) => json(res, 200, { choices: [{ message: { role: 'assistant', content: 'cloud reply' } }] });
    const cloud = new OpenAIClient({ baseUrl: process.env.HARNESS_LOCAL_BASE_URL!, apiKey: 'k', model: 'm' });
    const seen: string[] = [];
    const result = await cloud.chat([{ role: 'user', content: 'x' }], undefined, undefined, { onContent: (text) => seen.push(text) });
    expect(result.message.content).toBe('cloud reply');
    expect(seen).toEqual([]);
    expect(requests[0].body).toMatchObject({ stream: false });
    expect(cloud.getLocality()).toBe('cloud');
  });

  it('shows the reasoning when a thinking model writes no answer, and retries an empty reply', async () => {
    handler = (_req, _body, res) => sse(res, [{ choices: [{ delta: { reasoning_content: 'The user wants a greeting. ' } }] }, { choices: [{ delta: { reasoning_content: 'Hello!' } }] }]);
    const thought = await createLocalServerClient('qwen').chat([{ role: 'user', content: 'hi' }]);
    expect(thought.message.content).toBe('The user wants a greeting. Hello!');

    let calls = 0;
    handler = (_req, _body, res) => { calls += 1; sse(res, calls === 1 ? [{ choices: [{ delta: { content: '' } }] }] : [{ choices: [{ delta: { content: 'second try' } }] }]); };
    const retried = await createLocalServerClient('qwen').chat([{ role: 'user', content: 'hi' }]);
    expect(retried.message.content).toBe('second try');
    expect(calls).toBe(2);
  });

  it('keeps a last frame that has no trailing newline', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }));
    };
    const result = await createLocalServerClient('qwen').chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.content).toBe('Hello world');
  });

  it('counts only this machine as local', () => {
    expect(isLoopbackServer('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLoopbackServer('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackServer('http://[::1]:8000/v1')).toBe(true);
    expect(isLoopbackServer('http://192.168.1.20:8080/v1')).toBe(false);
    expect(isLoopbackServer('not a url')).toBe(false);
    process.env.HARNESS_LOCAL_BASE_URL = 'http://192.168.1.20:8080/v1';
    expect(createLocalServerClient('qwen').getLocality()).toBe('unknown');
  });

  it('caches the model list briefly', async () => {
    let served = 0;
    handler = (_req, _body, res) => { served += 1; json(res, 200, { data: [{ id: 'm' + served }] }); };
    expect(await listLocalServerModels()).toEqual(['m1']);
    expect(await listLocalServerModels()).toEqual(['m1']);
    expect(served).toBe(1);
  });

  it('recognises local/ model ids', () => {
    expect(localServerModelName('local/qwen3.8-flash-next')).toBe('qwen3.8-flash-next');
    expect(localServerModelName('LOCAL/a/b')).toBe('a/b');
    expect(localServerModelName('groq/llama')).toBeNull();
    expect(localServerModelName('qwen3:8b')).toBeNull();
  });
});
