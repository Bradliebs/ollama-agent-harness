import { HarnessError, PermissionDeniedError } from '../core/errors';
import { McpCapabilityCache } from './mcpCapabilityCache';
import type { McpProtocolTool } from './mcpClient';

const TOOLS_A: McpProtocolTool[] = [{ name: 'echo', description: 'echo input' }];
const TOOLS_B: McpProtocolTool[] = [{ name: 'echo' }, { name: 'reverse' }];

function authError(): Error {
  const err = new Error('Unauthorized');
  (err as Error & { status?: number }).status = 401;
  return err;
}

function transientError(): Error {
  const err = new Error('connection refused');
  (err as Error & { code?: string }).code = 'ECONNREFUSED';
  return err;
}

describe('McpCapabilityCache', () => {
  it('returns the fetcher result on first call and marks it not cached', async () => {
    const cache = new McpCapabilityCache();
    const fetcher = jest.fn().mockResolvedValue(TOOLS_A);

    const result = await cache.getTools('srv', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.tools).toEqual(TOOLS_A);
    expect(result.cached).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.fetchedAt).toBeGreaterThan(0);
  });

  it('serves a fresh cached result on the second call without invoking the fetcher', async () => {
    const cache = new McpCapabilityCache();
    const fetcher = jest.fn().mockResolvedValue(TOOLS_A);

    const first = await cache.getTools('srv', fetcher);
    const second = await cache.getTools('srv', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.stale).toBe(false);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it('refreshes when the TTL has elapsed', async () => {
    const cache = new McpCapabilityCache(1000);
    const fetcher = jest.fn().mockResolvedValueOnce(TOOLS_A).mockResolvedValueOnce(TOOLS_B);

    const original = Date.now;
    let nowValue = 1_000_000;
    Date.now = () => nowValue;
    try {
      await cache.getTools('srv', fetcher);
      nowValue += 2000; // past TTL
      const second = await cache.getTools('srv', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(second.tools).toEqual(TOOLS_B);
      expect(second.cached).toBe(false);
    } finally {
      Date.now = original;
    }
  });

  it('respects per-call ttlMs override', async () => {
    const cache = new McpCapabilityCache(60_000);
    const fetcher = jest.fn().mockResolvedValue(TOOLS_A);

    const original = Date.now;
    let nowValue = 2_000_000;
    Date.now = () => nowValue;
    try {
      await cache.getTools('srv', fetcher, { ttlMs: 500 });
      nowValue += 1000; // past 500ms override
      await cache.getTools('srv', fetcher, { ttlMs: 500 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = original;
    }
  });

  it('forceRefresh skips the cache even when the entry is fresh', async () => {
    const cache = new McpCapabilityCache();
    const fetcher = jest.fn().mockResolvedValueOnce(TOOLS_A).mockResolvedValueOnce(TOOLS_B);

    await cache.getTools('srv', fetcher);
    const result = await cache.getTools('srv', fetcher, { forceRefresh: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.tools).toEqual(TOOLS_B);
    expect(result.cached).toBe(false);
  });

  it('collapses concurrent misses into a single fetcher invocation', async () => {
    const cache = new McpCapabilityCache();
    let resolveFetch: (tools: McpProtocolTool[]) => void = () => {};
    const fetcher = jest.fn().mockImplementation(
      () => new Promise<McpProtocolTool[]>((resolve) => { resolveFetch = resolve; }),
    );

    const a = cache.getTools('srv', fetcher);
    const b = cache.getTools('srv', fetcher);
    resolveFetch(TOOLS_A);
    const [resultA, resultB] = await Promise.all([a, b]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resultA.tools).toEqual(TOOLS_A);
    expect(resultB.tools).toEqual(TOOLS_A);
  });

  it('returns stale on transient failure when a prior entry exists', async () => {
    const cache = new McpCapabilityCache(0); // expire immediately
    const fetcher = jest.fn()
      .mockResolvedValueOnce(TOOLS_A)
      .mockRejectedValueOnce(transientError());

    await cache.getTools('srv', fetcher);
    const result = await cache.getTools('srv', fetcher);

    expect(result.tools).toEqual(TOOLS_A);
    expect(result.cached).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.lastError?.class).toBe('transient');
  });

  it('returns stale on unknown failure (does not auto-invalidate)', async () => {
    const cache = new McpCapabilityCache(0);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(TOOLS_A)
      .mockRejectedValueOnce(new Error('something weird'));

    await cache.getTools('srv', fetcher);
    const result = await cache.getTools('srv', fetcher);

    expect(result.stale).toBe(true);
    expect(result.lastError?.class).toBe('unknown');
  });

  it('returns stale on rate-limit failure', async () => {
    const cache = new McpCapabilityCache(0);
    const rateError = new Error('Too Many Requests');
    (rateError as Error & { status?: number }).status = 429;
    const fetcher = jest.fn()
      .mockResolvedValueOnce(TOOLS_A)
      .mockRejectedValueOnce(rateError);

    await cache.getTools('srv', fetcher);
    const result = await cache.getTools('srv', fetcher);

    expect(result.stale).toBe(true);
    expect(result.lastError?.class).toBe('rateLimited');
  });

  it('invalidates and re-throws on auth failure', async () => {
    const cache = new McpCapabilityCache(0);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(TOOLS_A)
      .mockRejectedValueOnce(authError());

    await cache.getTools('srv', fetcher);
    await expect(cache.getTools('srv', fetcher)).rejects.toThrow('Unauthorized');
    expect(cache.peek('srv')).toBeUndefined();
  });

  it('invalidates and re-throws on policy-denied failure', async () => {
    const cache = new McpCapabilityCache(0);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(TOOLS_A)
      .mockRejectedValueOnce(new PermissionDeniedError('mcp', 'denied'));

    await cache.getTools('srv', fetcher);
    await expect(cache.getTools('srv', fetcher)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(cache.peek('srv')).toBeUndefined();
  });

  it('invalidates and re-throws on permanent harness failure', async () => {
    const cache = new McpCapabilityCache(0);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(TOOLS_A)
      .mockRejectedValueOnce(new HarnessError('boom', 'BOOM', false));

    await cache.getTools('srv', fetcher);
    await expect(cache.getTools('srv', fetcher)).rejects.toThrow('boom');
    expect(cache.peek('srv')).toBeUndefined();
  });

  it('re-throws transient failure when no prior entry exists', async () => {
    const cache = new McpCapabilityCache();
    const fetcher = jest.fn().mockRejectedValue(transientError());

    await expect(cache.getTools('srv', fetcher)).rejects.toThrow('connection refused');
    expect(cache.peek('srv')).toBeUndefined();
  });

  it('invalidate removes the entry', async () => {
    const cache = new McpCapabilityCache();
    const fetcher = jest.fn().mockResolvedValue(TOOLS_A);
    await cache.getTools('srv', fetcher);

    cache.invalidate('srv');
    await cache.getTools('srv', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clear empties all entries', async () => {
    const cache = new McpCapabilityCache();
    const fetcherA = jest.fn().mockResolvedValue(TOOLS_A);
    const fetcherB = jest.fn().mockResolvedValue(TOOLS_B);
    await cache.getTools('a', fetcherA);
    await cache.getTools('b', fetcherB);

    cache.clear();

    expect(cache.peek('a')).toBeUndefined();
    expect(cache.peek('b')).toBeUndefined();
  });

  it('peek does not affect TTL semantics', async () => {
    const cache = new McpCapabilityCache(60_000);
    const fetcher = jest.fn().mockResolvedValue(TOOLS_A);
    await cache.getTools('srv', fetcher);

    const peeked = cache.peek('srv');
    expect(peeked?.tools).toEqual(TOOLS_A);
    expect(peeked?.stale).toBe(false);

    await cache.getTools('srv', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('after a stale-serving cycle, a successful refresh clears the stale flag', async () => {
    const cache = new McpCapabilityCache(0);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(TOOLS_A)
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce(TOOLS_B);

    await cache.getTools('srv', fetcher);
    const stale = await cache.getTools('srv', fetcher);
    expect(stale.stale).toBe(true);
    const recovered = await cache.getTools('srv', fetcher);

    expect(recovered.stale).toBe(false);
    expect(recovered.cached).toBe(false);
    expect(recovered.tools).toEqual(TOOLS_B);
  });
});
