import { ReplicateClient } from './replicateClient';

const originalFetch = global.fetch;
const fetchSpy = jest.fn();
beforeEach(() => {
  global.fetch = fetchSpy as unknown as typeof fetch;
  fetchSpy.mockReset();
});
afterAll(() => {
  global.fetch = originalFetch;
});

function makeResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

describe('ReplicateClient', () => {
  it('rejects blank apiKey', () => {
    expect(() => new ReplicateClient({ apiKey: '', model: 'meta/meta-llama-3-8b-instruct' })).toThrow(/apiKey/);
  });

  it('rejects blank model', () => {
    expect(() => new ReplicateClient({ apiKey: 'r8_test', model: '' })).toThrow(/model/);
  });

  it('parses a succeeded prediction', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      id: 'pred_123',
      status: 'succeeded',
      output: ['Hello', ' world'],
    }));
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'meta/meta-llama-3-8b-instruct' });
    const result = await client.chat([{ role: 'user', content: 'Hi' }]);
    expect(result.message.content).toBe('Hello world');
    expect(result.message.role).toBe('assistant');
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('/models/meta/meta-llama-3-8b-instruct/predictions');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.input.prompt).toContain('USER: Hi');
  });

  it('uses /predictions with version for versioned models', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      status: 'succeeded',
      output: 'ok',
    }));
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'abc123:def456' });
    await client.chat([{ role: 'user', content: 'hi' }]);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/predictions$/);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.version).toBe('abc123:def456');
  });

  it('throws on HTTP errors with detail', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(
      { detail: 'Invalid token' },
      { status: 401, ok: false },
    ));
    const client = new ReplicateClient({ apiKey: 'bad', model: 'meta/meta-llama-3-8b-instruct' });
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Replicate HTTP 401.*Invalid token/);
  });

  it('throws on failed predictions', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      status: 'failed',
      error: 'Out of memory',
    }));
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'meta/meta-llama-3-8b-instruct' });
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/prediction failed.*Out of memory/);
  });

  it('rejects tool calls', async () => {
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'meta/meta-llama-3-8b-instruct' });
    await expect(client.chat(
      [{ role: 'user', content: 'hi' }],
      [{ type: 'function', function: { name: 'test', description: '', parameters: { type: 'object', properties: {} } } }],
    )).rejects.toThrow(/does not support.*tool/i);
  });

  it('returns the model name', () => {
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'meta/meta-llama-3-8b-instruct' });
    expect(client.getModel()).toBe('meta/meta-llama-3-8b-instruct');
  });

  it('healthCheck always returns ok', async () => {
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'meta/meta-llama-3-8b-instruct' });
    const result = await client.healthCheck();
    expect(result.ok).toBe(true);
  });

  it('handles string output', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      status: 'succeeded',
      output: 'Just a string',
    }));
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'meta/meta-llama-3-8b-instruct' });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.content).toBe('Just a string');
  });

  it('handles object output with text field', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({
      status: 'succeeded',
      output: { text: 'From text field' },
    }));
    const client = new ReplicateClient({ apiKey: 'r8_test', model: 'meta/meta-llama-3-8b-instruct' });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.content).toBe('From text field');
  });
});

describe('ReplicateClient in fallback', () => {
  it('can be imported alongside chatClientFactory', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { REPLICATE_PRESET } = require('./chatClientFactory');
    expect(REPLICATE_PRESET.label).toBe('Replicate');
    expect(REPLICATE_PRESET.supportsTools).toBe(false);
    expect(REPLICATE_PRESET.apiKeyEnvVars).toContain('REPLICATE_API_TOKEN');
  });
});
