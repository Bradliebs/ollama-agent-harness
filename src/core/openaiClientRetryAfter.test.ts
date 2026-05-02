/**
 * Integration coverage for OpenAIClient retry behavior using a real HTTP
 * server. The mock-based tests cover the request-shape contract; this
 * file verifies that the live fetch -> Response -> retry path actually
 * honours the Retry-After header that providers like Cerebras and
 * OpenRouter return on 429.
 *
 * Why a separate file: stand up an http server per test, then tear it
 * down. We deliberately avoid mocking global fetch here so any future
 * refactor (e.g. switching to undici directly) keeps these guarantees.
 */
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { OpenAIClient } from './openaiClient';

jest.setTimeout(15_000);

interface RequestRecord {
  receivedAt: number;
  authorization?: string;
}

/**
 * Spin up a server that fakes Cerebras-style throttling: returns 429 with
 * a `Retry-After: <seconds>` header for the first `throttleCount` requests,
 * then a successful chat completion for subsequent requests. Records the
 * arrival time and Authorization header of every request so tests can
 * assert backoff timing and key rotation.
 */
async function makeThrottlingServer(throttleCount: number, retryAfterSeconds: number): Promise<{
  baseUrl: string;
  requests: RequestRecord[];
  close: () => Promise<void>;
}> {
  const requests: RequestRecord[] = [];
  let served = 0;
  const server: Server = createServer((req, res) => {
    requests.push({
      receivedAt: Date.now(),
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    });
    if (served < throttleCount) {
      served++;
      res.statusCode = 429;
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('OpenAIClient Retry-After header (real HTTP)', () => {
  it('waits for the server-supplied Retry-After delay before retrying', async () => {
    const { baseUrl, requests, close } = await makeThrottlingServer(1, 1);
    try {
      const client = new OpenAIClient({
        baseUrl,
        apiKey: 'integration-key',
        model: 'm',
        maxRetries: 3,
        retryBaseDelayMs: 50, // small, so we can prove Retry-After overrides this
      });

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(requests.length).toBe(2);
      const elapsed = requests[1].receivedAt - requests[0].receivedAt;
      // Server said wait 1 second; allow a small tolerance for scheduler jitter.
      expect(elapsed).toBeGreaterThanOrEqual(900);
      // And not absurdly long either — proves it's not blocking on something
      // unrelated like the default exponential backoff.
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await close();
    }
  });

  it('rotates Authorization header across retries when a key pool is configured', async () => {
    const { baseUrl, requests, close } = await makeThrottlingServer(2, 0);
    try {
      const client = new OpenAIClient({
        baseUrl,
        apiKey: ['key-A', 'key-B', 'key-C'],
        model: 'm',
        maxRetries: 3,
        retryBaseDelayMs: 1,
      });

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(requests.length).toBe(3);
      expect(requests[0].authorization).toBe('Bearer key-A');
      expect(requests[1].authorization).toBe('Bearer key-B');
      expect(requests[2].authorization).toBe('Bearer key-C');
    } finally {
      await close();
    }
  });

  it('surfaces the upstream error body when retries are exhausted', async () => {
    const { baseUrl, close } = await makeThrottlingServer(10, 0);
    try {
      const client = new OpenAIClient({
        baseUrl,
        apiKey: 'k',
        model: 'm',
        providerLabel: 'IntegrationProv',
        maxRetries: 2,
        retryBaseDelayMs: 1,
      });

      await expect(client.chat([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/IntegrationProv HTTP 429.*rate limited/);
    } finally {
      await close();
    }
  });
});
