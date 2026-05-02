import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { OllamaClient, longLivedFetch } from './ollamaClient';

const mockChat = jest.fn();
const mockShow = jest.fn();
const mockList = jest.fn();

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({ chat: mockChat, show: mockShow, list: mockList })),
}));

describe('OllamaClient context configuration', () => {
  beforeEach(() => {
    mockChat.mockReset();
    mockShow.mockReset();
    mockList.mockReset();
  });

  it('passes num_ctx to chat requests when configured', async () => {
    mockChat.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      prompt_eval_count: 1,
      eval_count: 1,
      total_duration: 1,
    });
    const client = new OllamaClient({ model: 'test-model', numCtx: 32768 });

    await client.chat([{ role: 'user', content: 'hello' }]);

    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'test-model',
      stream: true,
      options: { num_ctx: 32768 },
    }));
  });

  it('aggregates streamed chat chunks into one assistant response', async () => {
    async function* chunks() {
      yield { message: { role: 'assistant', content: 'hel' }, done: false };
      yield {
        message: { role: 'assistant', content: 'lo' },
        done: true,
        prompt_eval_count: 12,
        eval_count: 3,
        total_duration: 4_000_000,
      };
    }
    mockChat.mockResolvedValue(chunks());
    const client = new OllamaClient({ model: 'test-model' });

    await expect(client.chat([{ role: 'user', content: 'hello' }])).resolves.toEqual({
      message: { role: 'assistant', content: 'hello' },
      usage: { promptTokens: 12, completionTokens: 3, totalDurationNs: 4_000_000 },
    });
  });

  it('aborts an in-flight streamed chat response', async () => {
    let releaseStream: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
    const stream = {
      abort: jest.fn(() => releaseStream()),
      async *[Symbol.asyncIterator]() {
        yield { message: { role: 'assistant', content: 'partial' }, done: false };
        await gate;
        yield { message: { role: 'assistant', content: 'ignored' }, done: true };
      },
    };
    mockChat.mockResolvedValue(stream);
    const controller = new AbortController();
    const client = new OllamaClient({ model: 'test-model' });

    const result = client.chat([{ role: 'user', content: 'hello' }], undefined, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toThrow('aborted');
    expect(stream.abort).toHaveBeenCalledTimes(1);
  });

  it('detects context window from model_info', async () => {
    mockShow.mockResolvedValue({ model_info: new Map([['llama.context_length', 131072]]), parameters: '' });
    const client = new OllamaClient({ model: 'large-context' });

    await expect(client.getContextWindow()).resolves.toBe(131072);
  });

  it('falls back to num_ctx parameters when model_info has no context length', async () => {
    mockShow.mockResolvedValue({ model_info: new Map(), parameters: 'num_ctx 65536\ntemperature 0.7' });
    const client = new OllamaClient({ model: 'parameter-context' });

    await expect(client.getContextWindow()).resolves.toBe(65536);
  });
});

describe('longLivedFetch transport', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
  });

  it('waits for delayed response headers and reads the streamed body', async () => {
    const url = await listen((_, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('delayed ');
        response.end('ok');
      }, 25);
    });

    const response = await longLivedFetch(url);

    await expect(response.text()).resolves.toBe('delayed ok');
    expect(response.status).toBe(200);
  });

  it('sends string request bodies with content-length', async () => {
    const seen = { body: '', contentLength: '' };
    const url = await listen((request, response) => {
      seen.contentLength = String(request.headers['content-length'] ?? '');
      request.setEncoding('utf-8');
      request.on('data', (chunk) => { seen.body += chunk; });
      request.on('end', () => {
        response.writeHead(201, { 'Content-Type': 'text/plain' });
        response.end('received');
      });
    });

    const response = await longLivedFetch(url, { method: 'POST', body: 'hello' });

    await expect(response.text()).resolves.toBe('received');
    expect(response.status).toBe(201);
    expect(seen.body).toBe('hello');
    expect(seen.contentLength).toBe('5');
  });

  it('rejects when aborted before response headers arrive', async () => {
    const url = await listen((_request, _response) => {
      // Keep the request open until the client aborts.
    });
    const controller = new AbortController();

    const result = longLivedFetch(url, { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toThrow('aborted');
  });

  async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    return `http://127.0.0.1:${address.port}/`;
  }
});
