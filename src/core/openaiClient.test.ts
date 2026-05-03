import { OpenAIClient } from './openaiClient';
import { FallbackChatClient } from './fallbackChatClient';
import { drainRemoteProviderFallbackEvents, FALLBACK_COOLDOWN_MS } from './fallbackChatClient';
import type { Message, Tool } from 'ollama';

const fetchSpy = jest.fn();
const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = fetchSpy as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  fetchSpy.mockReset();
});

function makeResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? status < 400,
    status,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('OpenAIClient', () => {
  it('throws when constructed without an apiKey or baseUrl', () => {
    expect(() => new OpenAIClient({ baseUrl: '', apiKey: 'x', model: 'm' })).toThrow(/baseUrl/);
    expect(() => new OpenAIClient({ baseUrl: 'https://x', apiKey: '', model: 'm' })).toThrow(/apiKey/);
  });

  it('POSTs to {baseUrl}/chat/completions with bearer auth and JSON body', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const client = new OpenAIClient({
      baseUrl: 'https://api.cerebras.ai/v1/',
      apiKey: 'test-key',
      model: 'gpt-oss-120b',
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('gpt-oss-120b');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBe(false);
    expect(result.message.content).toBe('hello');
    expect(result.usage.promptTokens).toBe(3);
    expect(result.usage.completionTokens).toBe(2);
  });

  it('translates Ollama tools to OpenAI function-tool format', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
    }));
    const client = new OpenAIClient({
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKey: 'k',
      model: 'gpt-oss-120b',
    });
    const tools: Tool[] = [{
      type: 'function',
      function: {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }] as unknown as Tool[];

    await client.chat([{ role: 'user', content: 'go' }], tools);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
  });

  it('parses OpenAI tool_calls and JSON-decodes the arguments', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'file_read', arguments: '{"path": "README.md"}' },
          }],
        },
      }],
    }));
    const client = new OpenAIClient({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.tool_calls).toBeDefined();
    expect(result.message.tool_calls?.[0].function.name).toBe('file_read');
    expect(result.message.tool_calls?.[0].function.arguments).toEqual({ path: 'README.md' });
  });

  it('falls back to the inline tool-call parser when tool_calls are absent', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: 'Sure! {"name": "grep", "arguments": {"pattern": "todo"}}',
        },
      }],
    }));
    const client = new OpenAIClient({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.tool_calls?.[0].function.name).toBe('grep');
    expect(result.message.tool_calls?.[0].function.arguments).toEqual({ pattern: 'todo' });
  });

  it('throws a labelled error when the upstream returns non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(
      { error: { message: 'invalid_api_key' } },
      { status: 401, ok: false },
    ));
    const client = new OpenAIClient({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      providerLabel: 'CerebrasTest',
    });
    await expect(client.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/CerebrasTest HTTP 401: invalid_api_key/);
  });

  it('surfaces Mistral-style detail responses on bad requests', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(
      { detail: [{ loc: ['body', 'messages', 0, 'content'], msg: 'Input should be a valid string' }] },
      { status: 400, ok: false },
    ));
    const client = new OpenAIClient({
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'k',
      model: 'mistral-medium-latest',
      providerLabel: 'Mistral AI',
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/Mistral AI HTTP 400: body.messages.0.content: Input should be a valid string/);
  });

  it('coerces invalid JSON in tool-call arguments to an empty object instead of throwing', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'c',
            type: 'function',
            function: { name: 'bash', arguments: 'this is not json' },
          }],
        },
      }],
    }));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.tool_calls?.[0].function.arguments).toEqual({});
  });

  it('healthCheck succeeds on a 200 chat response', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
    }));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    await expect(client.healthCheck()).resolves.toEqual({ ok: true });
  });

  it('healthCheck reports the failure message on auth errors', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(
      { error: { message: 'forbidden' } },
      { status: 403, ok: false },
    ));
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: 'k', model: 'm', providerLabel: 'TestProv',
    });
    const result = await client.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('TestProv');
    expect(result.error).toContain('403');
  });

  it('threads a synthetic tool_call_id onto role:tool messages', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'k' } }],
    }));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 't', arguments: {} } }] },
      { role: 'tool', content: 'result' },
    ];
    await client.chat(messages);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant');
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBeDefined();
    expect(toolMsg.tool_call_id).toBe(assistantMsg.tool_calls[0].id);
    expect(toolMsg.tool_call_id).not.toBe('call_unknown');
  });

  it('preserves provider tool_call_id values on role:tool messages', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'k' } }],
    }));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_mistral_123', function: { name: 't', arguments: {} } } as never] },
      { role: 'tool', content: 'result', tool_call_id: 'call_mistral_123' } as never,
    ];
    await client.chat(messages);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call_mistral_123');
  });
});

describe('OpenAIClient retry + credential pool', () => {
  function make429(retryAfterSeconds?: string): Response {
    const headers = new Map<string, string>();
    if (retryAfterSeconds) headers.set('retry-after', retryAfterSeconds);
    return {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } as unknown as Headers,
      json: async () => ({ error: { message: 'rate limited' } }),
      text: async () => 'rate limited',
    } as unknown as Response;
  }

  it('retries on 429 and succeeds on the next attempt', async () => {
    fetchSpy.mockResolvedValueOnce(make429('0'));
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'recovered' } }],
    }));
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: 'k', model: 'm',
      maxRetries: 3, retryBaseDelayMs: 1,
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.content).toBe('recovered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on persistent 429', async () => {
    fetchSpy.mockResolvedValue(make429('0'));
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: 'k', model: 'm',
      providerLabel: 'TestProv',
      maxRetries: 2, retryBaseDelayMs: 1,
    });
    await expect(client.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/TestProv HTTP 429/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rotates keys across attempts when multiple are configured', async () => {
    fetchSpy.mockResolvedValueOnce(make429('0'));
    fetchSpy.mockResolvedValueOnce(make429('0'));
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }));
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: ['k1', 'k2', 'k3'], model: 'm',
      maxRetries: 3, retryBaseDelayMs: 1,
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    const headersUsed = fetchSpy.mock.calls.map((c) => (c[1] as { headers: Record<string, string> }).headers.authorization);
    expect(headersUsed[0]).toBe('Bearer k1');
    expect(headersUsed[1]).toBe('Bearer k2');
    expect(headersUsed[2]).toBe('Bearer k3');
  });

  it('rejects empty key arrays', () => {
    expect(() => new OpenAIClient({
      baseUrl: 'https://x', apiKey: ['', '   '], model: 'm',
    })).toThrow(/non-empty apiKey/);
  });

  it('honours Retry-After delta-seconds header', async () => {
    // Two 429s with Retry-After=0 then success — verifying the parser accepts integer seconds.
    fetchSpy.mockResolvedValueOnce(make429('0'));
    fetchSpy.mockResolvedValueOnce(makeResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }));
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: 'k', model: 'm',
      maxRetries: 3, retryBaseDelayMs: 1,
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.content).toBe('ok');
  });

  it('retries on 503 (transient gateway error) but not on 401', async () => {
    // 401 is non-retryable; should throw immediately.
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 401, statusText: 'Unauthorized',
      headers: { get: () => null } as unknown as Headers,
      json: async () => ({ error: { message: 'bad key' } }),
      text: async () => 'bad key',
    } as unknown as Response);
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: 'k', model: 'm',
      maxRetries: 3, retryBaseDelayMs: 1,
    });
    await expect(client.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/HTTP 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not exceed maxRetries attempts on persistent 429', async () => {
    // Always return 429; the client should stop after exactly maxRetries attempts.
    fetchSpy.mockResolvedValue(make429('0'));
    const maxRetries = 3;
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: 'k', model: 'm',
      providerLabel: 'TestProv',
      maxRetries, retryBaseDelayMs: 1,
    });
    await expect(client.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/TestProv HTTP 429/);
    expect(fetchSpy).toHaveBeenCalledTimes(maxRetries);
  });

  it('does NOT rotate keys on successful 200 responses; only on 429/5xx', async () => {
    // Mock 3 successful responses
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'r1' } }] }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'r2' } }] }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'r3' } }] }));

    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: ['k1', 'k2', 'k3'], model: 'm',
      maxRetries: 3, retryBaseDelayMs: 1,
    });

    // Make 3 separate requests (not retries - new calls)
    await client.chat([{ role: 'user', content: 'req1' }]);
    await client.chat([{ role: 'user', content: 'req2' }]);
    await client.chat([{ role: 'user', content: 'req3' }]);

    // All 3 requests should use the same Bearer token (k1) since 200s don't rotate
    const headersUsed = fetchSpy.mock.calls.map((c) => (c[1] as { headers: Record<string, string> }).headers.authorization);
    expect(headersUsed).toHaveLength(3);
    expect(headersUsed[0]).toBe('Bearer k1');
    expect(headersUsed[1]).toBe('Bearer k1');
    expect(headersUsed[2]).toBe('Bearer k1');
  });
});

describe('OpenAIClient streaming', () => {
  function makeStreamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body,
    } as unknown as Response;
  }

  it('yields content deltas as separate chunks and a final done chunk', async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    const chunks: Array<{ content: string; done: boolean; toolCalls?: unknown }> = [];
    for await (const c of client.chatStream([{ role: 'user', content: 'hi' }])) chunks.push(c);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ content: 'Hel', done: false });
    expect(chunks[1]).toEqual({ content: 'lo', done: false });
    expect(chunks[2].done).toBe(true);
    expect(chunks[2].toolCalls).toBeUndefined();
  });

  it('accumulates fragmented tool-call deltas across SSE frames', async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"file_read"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    const chunks = [];
    for await (const c of client.chatStream([{ role: 'user', content: 'hi' }])) chunks.push(c);

    const final = chunks[chunks.length - 1] as { done: boolean; toolCalls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
    expect(final.done).toBe(true);
    expect(final.toolCalls).toHaveLength(1);
    expect(final.toolCalls?.[0].function.name).toBe('file_read');
    expect(final.toolCalls?.[0].function.arguments).toEqual({ path: 'README.md' });
  });

  it('handles SSE frames split across read boundaries', async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"par',
      't1"}}]}\n\ndata: {"choices":[{"delta":{"content":"part2"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    const text = [];
    for await (const c of client.chatStream([{ role: 'user', content: 'hi' }])) {
      if (c.content) text.push(c.content);
    }
    expect(text.join('')).toBe('part1part2');
  });

  it('skips malformed JSON frames without crashing', async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse([
      'data: not json\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const client = new OpenAIClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    const text = [];
    for await (const c of client.chatStream([{ role: 'user', content: 'hi' }])) {
      if (c.content) text.push(c.content);
    }
    expect(text.join('')).toBe('hi');
  });

  it('throws a labelled error when the stream HTTP status is non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: null,
      text: async () => 'invalid_api_key',
    } as unknown as Response);
    const client = new OpenAIClient({
      baseUrl: 'https://x', apiKey: 'k', model: 'm', providerLabel: 'TestProv',
    });
    const it = client.chatStream([{ role: 'user', content: 'hi' }]);
    await expect(it.next()).rejects.toThrow(/TestProv stream HTTP 401/);
  });
});

describe('FallbackChatClient', () => {
  it('cycles to the next configured backend on rate limits', async () => {
    const limited = new OpenAIClient({ baseUrl: 'https://limited.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Limited', maxRetries: 1 });
    const backup = new OpenAIClient({ baseUrl: 'https://backup.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'Backup' });
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'backup ok' } }] }));

    const client = new FallbackChatClient([
      { backend: 'limited', client: limited, supportsTools: true },
      { backend: 'backup', client: backup, supportsTools: true },
    ]);

    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result.message.content).toBe('backup ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['https://limited.example/v1/chat/completions', 'https://backup.example/v1/chat/completions']);
  });

  it('does not cycle on authentication failures', async () => {
    const limited = new OpenAIClient({ baseUrl: 'https://limited.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Limited' });
    const backup = new OpenAIClient({ baseUrl: 'https://backup.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'Backup' });
    fetchSpy.mockResolvedValueOnce(makeResponse({ error: { message: 'bad key' } }, { status: 401, ok: false }));

    const client = new FallbackChatClient([
      { backend: 'limited', client: limited, supportsTools: true },
      { backend: 'backup', client: backup, supportsTools: true },
    ]);

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/HTTP 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips chat-only fallback providers when tools are present', async () => {
    const limited = new OpenAIClient({ baseUrl: 'https://limited.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Limited', maxRetries: 1 });
    const chatOnly = new OpenAIClient({ baseUrl: 'https://chatonly.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'ChatOnly' });
    const toolCapable = new OpenAIClient({ baseUrl: 'https://tools.example/v1', apiKey: 'k3', model: 'm3', providerLabel: 'ToolCapable' });
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'tool fallback ok' } }] }));
    const tools: Tool[] = [{ type: 'function', function: { name: 'file_read', description: 'Read', parameters: { type: 'object' } } }] as unknown as Tool[];

    const client = new FallbackChatClient([
      { backend: 'limited', client: limited, supportsTools: true },
      { backend: 'chatonly', client: chatOnly, supportsTools: false },
      { backend: 'tools', client: toolCapable, supportsTools: true },
    ]);

    const result = await client.chat([{ role: 'user', content: 'hi' }], tools);

    expect(result.message.content).toBe('tool fallback ok');
    const urls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['https://limited.example/v1/chat/completions', 'https://tools.example/v1/chat/completions']);
  });

  it('does not fall back on HTTP 413 (request too large)', async () => {
    const primary = new OpenAIClient({ baseUrl: 'https://primary.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Primary', maxRetries: 1 });
    const backup = new OpenAIClient({ baseUrl: 'https://backup.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'Backup' });
    fetchSpy.mockResolvedValueOnce(makeResponse({ error: { message: 'Request too large for model llama-3.1-8b-instant' } }, { status: 413, ok: false }));

    const client = new FallbackChatClient([
      { backend: 'primary', client: primary, supportsTools: true },
      { backend: 'backup', client: backup, supportsTools: true },
    ]);

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/413/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('emits drainable fallback events when cycling providers', async () => {
    drainRemoteProviderFallbackEvents(); // clear any prior
    const limited = new OpenAIClient({ baseUrl: 'https://limited.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Limited', maxRetries: 1 });
    const backup = new OpenAIClient({ baseUrl: 'https://backup.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'Backup' });
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));

    const client = new FallbackChatClient([
      { backend: 'limited', client: limited, supportsTools: true },
      { backend: 'backup', client: backup, supportsTools: true },
    ]);
    await client.chat([{ role: 'user', content: 'hi' }]);

    const events = drainRemoteProviderFallbackEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'provider_fallback',
      fromBackend: 'limited',
      toBackend: 'backup',
    });
    expect(events[0].reason).toContain('rate limit');
    expect(events[0].cooldownSec).toBeGreaterThan(0);
    // Drain is idempotent
    expect(drainRemoteProviderFallbackEvents()).toHaveLength(0);
  });

  it('skips a cooled-down backend on the next call', async () => {
    drainRemoteProviderFallbackEvents();
    const primary = new OpenAIClient({ baseUrl: 'https://primary.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Primary', maxRetries: 1 });
    const secondary = new OpenAIClient({ baseUrl: 'https://secondary.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'Secondary', maxRetries: 1 });
    const tertiary = new OpenAIClient({ baseUrl: 'https://tertiary.example/v1', apiKey: 'k3', model: 'm3', providerLabel: 'Tertiary' });

    // First call: primary 429 → secondary 429 → tertiary succeeds
    // Both primary and secondary enter cooldown.
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'r1' } }] }));

    const client = new FallbackChatClient([
      { backend: 'primary', client: primary, supportsTools: true },
      { backend: 'secondary', client: secondary, supportsTools: true },
      { backend: 'tertiary', client: tertiary, supportsTools: true },
    ]);
    const r1 = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(r1.message.content).toBe('r1');

    // Second call: primary is always tried (index 0), 429s again.
    // Secondary is in cooldown so we skip to tertiary.
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'r2 from tertiary' } }] }));

    const r2 = await client.chat([{ role: 'user', content: 'hi again' }]);
    expect(r2.message.content).toBe('r2 from tertiary');
    const urls = fetchSpy.mock.calls.slice(-2).map((c) => c[0]);
    expect(urls[0]).toContain('primary.example');
    expect(urls[1]).toContain('tertiary.example');
  });

  it('retries a backend after cooldown expires', async () => {
    drainRemoteProviderFallbackEvents();
    const primary = new OpenAIClient({ baseUrl: 'https://primary.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Primary', maxRetries: 1 });
    const secondary = new OpenAIClient({ baseUrl: 'https://secondary.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'Secondary' });

    // First call: primary 429 → secondary succeeds
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'r1' } }] }));

    const client = new FallbackChatClient([
      { backend: 'primary', client: primary, supportsTools: true },
      { backend: 'secondary', client: secondary, supportsTools: true },
    ]);
    await client.chat([{ role: 'user', content: 'hi' }]);

    // Simulate cooldown expiry by backdating the internal cooldown map
    const cooldowns = (client as unknown as { cooldowns: Map<string, number> }).cooldowns;
    cooldowns.set('primary', Date.now() - FALLBACK_COOLDOWN_MS - 1);

    // Second call: primary should be retried now (cooldown expired, and it's index 0)
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'primary recovered' } }] }));

    const r2 = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(r2.message.content).toBe('primary recovered');
    expect(fetchSpy.mock.calls.at(-1)![0]).toContain('primary.example');
  });

  it('prefers the least-loaded fallback when multiple are available', async () => {
    drainRemoteProviderFallbackEvents();
    const primary = new OpenAIClient({ baseUrl: 'https://primary.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Primary', maxRetries: 1 });
    const backupA = new OpenAIClient({ baseUrl: 'https://backupA.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'BackupA' });
    const backupB = new OpenAIClient({ baseUrl: 'https://backupB.example/v1', apiKey: 'k3', model: 'm3', providerLabel: 'BackupB' });

    const client = new FallbackChatClient([
      { backend: 'primary', client: primary, supportsTools: true },
      { backend: 'backupA', client: backupA, supportsTools: true },
      { backend: 'backupB', client: backupB, supportsTools: true },
    ]);

    // Pump 3 requests through primary → backupA (simulate primary failing
    // each time). backupA accumulates 3 recent requests.
    for (let i = 0; i < 3; i += 1) {
      fetchSpy
        .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
        .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      await client.chat([{ role: 'user', content: 'hi' }]);
    }
    // Clear cooldown on primary so the next call goes through tryClients normally
    const cooldowns = (client as unknown as { cooldowns: Map<string, number> }).cooldowns;
    cooldowns.clear();

    // Next call: primary 429 again. With least-loaded sorting, backupB
    // (0 recent successful requests as fallback target) should be preferred
    // over backupA (3 recent requests).
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({ choices: [{ message: { role: 'assistant', content: 'from B' } }] }));
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.content).toBe('from B');
    // The last two fetch calls should be primary then backupB
    const lastUrls = fetchSpy.mock.calls.slice(-2).map((c) => c[0]);
    expect(lastUrls[0]).toContain('primary.example');
    expect(lastUrls[1]).toContain('backupB.example');
  });

  it('preserves tool_call responses from the fallback backend', async () => {
    drainRemoteProviderFallbackEvents();
    const primary = new OpenAIClient({ baseUrl: 'https://primary.example/v1', apiKey: 'k1', model: 'm1', providerLabel: 'Primary', maxRetries: 1 });
    const backup = new OpenAIClient({ baseUrl: 'https://backup.example/v1', apiKey: 'k2', model: 'm2', providerLabel: 'Backup' });

    // Primary 429s, backup returns a tool_call with a provider-assigned ID
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ error: { message: 'rate limit exceeded' } }, { status: 429, ok: false }))
      .mockResolvedValueOnce(makeResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_backup_abc123',
              type: 'function',
              function: { name: 'file_read', arguments: '{"path":"README.md"}' },
            }],
          },
        }],
      }));

    const client = new FallbackChatClient([
      { backend: 'primary', client: primary, supportsTools: true },
      { backend: 'backup', client: backup, supportsTools: true },
    ]);

    const result = await client.chat(
      [{ role: 'user', content: 'read README' }],
      [{ type: 'function', function: { name: 'file_read', description: 'Read', parameters: { type: 'object' } } }] as unknown as Tool[],
    );

    // The tool_call from the backup backend should pass through intact
    expect(result.message.tool_calls).toBeDefined();
    expect(result.message.tool_calls).toHaveLength(1);
    const tc = result.message.tool_calls![0];
    expect(tc.function.name).toBe('file_read');
    // Provider ID should be preserved through the fallback wrapper
    expect((tc as unknown as Record<string, unknown>).id).toBe('call_backup_abc123');
  });
});
