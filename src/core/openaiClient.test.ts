import { OpenAIClient } from './openaiClient';
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
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBeDefined();
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
