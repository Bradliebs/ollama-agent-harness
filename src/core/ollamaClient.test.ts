import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OllamaClient, drainOllamaChatRetryEvents, longLivedFetch, liftInlineToolCalls } from './ollamaClient';

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
    drainOllamaChatRetryEvents();
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

  it('writes payload metrics to debug logs', async () => {
    async function* chunks() {
      yield {
        message: { role: 'assistant', content: 'ok' },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
        total_duration: 1,
      };
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'harness-ollama-debug-'));
    const debugPath = join(tempDir, 'debug.jsonl');
    const previousDebugPath = process.env.HARNESS_DEBUG_LOG;
    process.env.HARNESS_DEBUG_LOG = debugPath;
    mockChat.mockResolvedValue(chunks());
    const client = new OllamaClient({ model: 'test-model' });

    try {
      await client.chat(
        [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'hello' }],
        [{ type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object' } } }],
      );

      const entries = readFileSync(debugPath, 'utf-8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(entries).toHaveLength(2);
      expect(entries[0].phase).toBe('request');
      expect(entries[1].phase).toBe('response');
      expect(entries[0].response).toBeUndefined();
      expect(entries[1].response).toMatchObject({ role: 'assistant', content: 'ok' });
      expect(entries[0].payload).toMatchObject({
        messageChars: 18,
        messageTokenEstimate: 5,
        toolCount: 1,
      });
      expect(entries[0].payload.toolSchemaChars).toBeGreaterThan(0);
      expect(entries[0].payload.toolSchemaTokenEstimate).toBeGreaterThan(0);
      expect(entries[0].payload.totalChars).toBe(entries[0].payload.messageChars + entries[0].payload.toolSchemaChars);
      expect(entries[1].payload).toEqual(entries[0].payload);
    } finally {
      if (previousDebugPath === undefined) delete process.env.HARNESS_DEBUG_LOG;
      else process.env.HARNESS_DEBUG_LOG = previousDebugPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retries transient Ollama chat failures once before surfacing an error', async () => {
    async function* chunks() {
      yield {
        message: { role: 'assistant', content: 'ok' },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
        total_duration: 1,
      };
    }
    const previousAttempts = process.env.HARNESS_OLLAMA_CHAT_MAX_ATTEMPTS;
    const previousDelay = process.env.HARNESS_OLLAMA_CHAT_RETRY_DELAY_MS;
    process.env.HARNESS_OLLAMA_CHAT_MAX_ATTEMPTS = '2';
    process.env.HARNESS_OLLAMA_CHAT_RETRY_DELAY_MS = '0';
    mockChat
      .mockRejectedValueOnce(new Error('Internal Server Error (ref: af1a42ac-ecdc-4b98-9ae1-c93491808e1f)'))
      .mockResolvedValueOnce(chunks());
    const client = new OllamaClient({ model: 'deepseek-v4-pro:cloud' });

    try {
      await expect(client.chat([{ role: 'user', content: 'hello' }])).resolves.toMatchObject({
        message: { role: 'assistant', content: 'ok' },
      });
      expect(mockChat).toHaveBeenCalledTimes(2);
      expect(drainOllamaChatRetryEvents()).toEqual([expect.objectContaining({
        type: 'model_retry',
        model: 'deepseek-v4-pro:cloud',
        attempt: 1,
        maxAttempts: 2,
        delayMs: 0,
        reason: expect.stringContaining('af1a42ac-ecdc-4b98-9ae1-c93491808e1f'),
      })]);
    } finally {
      if (previousAttempts === undefined) delete process.env.HARNESS_OLLAMA_CHAT_MAX_ATTEMPTS;
      else process.env.HARNESS_OLLAMA_CHAT_MAX_ATTEMPTS = previousAttempts;
      if (previousDelay === undefined) delete process.env.HARNESS_OLLAMA_CHAT_RETRY_DELAY_MS;
      else process.env.HARNESS_OLLAMA_CHAT_RETRY_DELAY_MS = previousDelay;
    }
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

describe('liftInlineToolCalls fallback parser', () => {
  it('extracts a {name, arguments} object from message content', () => {
    const message: any = {
      role: 'assistant',
      content: 'Sure! {"name": "file_read", "arguments": {"path": "README.md"}}',
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toEqual([
      { function: { name: 'file_read', arguments: { path: 'README.md' } } },
    ]);
    expect(message.content).toBe('Sure!');
  });

  it('handles fenced ```json blocks and strips the fence', () => {
    const message: any = {
      role: 'assistant',
      content: 'Here you go:\n```json\n{"name":"bash","arguments":{"command":"npm test"}}\n```',
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0].function.name).toBe('bash');
    expect(message.content).not.toContain('```');
    expect(message.content).not.toContain('"name"');
  });

  it('lifts the OpenAI {function: {name, arguments}} shape with stringified args', () => {
    const message: any = {
      role: 'assistant',
      content: '{"function": {"name": "grep", "arguments": "{\\"pattern\\":\\"todo\\"}"}}',
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toEqual([
      { function: { name: 'grep', arguments: { pattern: 'todo' } } },
    ]);
  });

  it('lifts multiple back-to-back tool-call JSON blobs', () => {
    const message: any = {
      role: 'assistant',
      content: '{"name":"a","arguments":{}}\n{"name":"b","arguments":{"x":1}}',
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls.map((tc: any) => tc.function.name)).toEqual(['a', 'b']);
  });

  it('lifts tool calls from a tool_calls envelope', () => {
    const message: any = {
      role: 'assistant',
      content: '{"tool_calls":[{"function":{"name":"web_search","arguments":"{\\"query\\":\\"latest news today\\"}"}}]}',
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toEqual([
      { function: { name: 'web_search', arguments: { query: 'latest news today' } } },
    ]);
    expect(message.content).toBe('');
  });

  it('lifts tool calls from tool_call and tool-name aliases', () => {
    const message: any = {
      role: 'assistant',
      content: '{"tool_call":{"tool_name":"file_read","parameters":{"path":"README.md"}}}',
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toEqual([
      { function: { name: 'file_read', arguments: { path: 'README.md' } } },
    ]);
  });

  it('does nothing when tool_calls already populated by the model', () => {
    const message: any = {
      role: 'assistant',
      content: '{"name":"file_read","arguments":{"path":"x"}}',
      tool_calls: [{ function: { name: 'real', arguments: {} } }],
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toEqual([{ function: { name: 'real', arguments: {} } }]);
  });

  it('does nothing on plain prose with no JSON', () => {
    const message: any = { role: 'assistant', content: 'Just chatting, no tools today.' };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toBeUndefined();
    expect(message.content).toBe('Just chatting, no tools today.');
  });

  it('ignores non-tool JSON objects in the content', () => {
    const message: any = {
      role: 'assistant',
      content: 'Here is some data: {"foo": 1, "bar": 2}',
    };
    liftInlineToolCalls(message);
    expect(message.tool_calls).toBeUndefined();
  });

  it('survives malformed JSON without throwing', () => {
    const message: any = {
      role: 'assistant',
      content: '{"name": "broken", "arguments": {oops not json',
    };
    expect(() => liftInlineToolCalls(message)).not.toThrow();
    expect(message.tool_calls).toBeUndefined();
  });
});
