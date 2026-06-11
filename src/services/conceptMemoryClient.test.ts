/**
 * Tests for conceptMemoryClient. The point of these tests is not to cover the
 * Python service — it is to lock the wire contract between this TS client and
 * ccmem/service.py so the two cannot silently drift apart again.
 *
 * Each test asserts both the request body shape AND the parsed response shape.
 */
import * as ccmem from './conceptMemoryClient';

type FetchCall = { url: string; init: RequestInit | undefined };

function installFetchMock(responder: (call: FetchCall) => { ok: boolean; body?: unknown }): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const original = global.fetch;
  global.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const { ok, body } = responder({ url, init });
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body ?? {},
    } as unknown as Response;
  }) as typeof global.fetch;
  return { calls, restore: () => { global.fetch = original; } };
}

function lastBody(calls: FetchCall[]): Record<string, unknown> {
  const last = calls[calls.length - 1];
  if (!last?.init?.body) throw new Error('no body on last call');
  return JSON.parse(last.init.body as string) as Record<string, unknown>;
}

describe('conceptMemoryClient', () => {
  beforeEach(() => {
    ccmem.setCcmemUrl('http://localhost:8765');
  });

  describe('store', () => {
    it('sends {text,label} to /write and returns {id,label}', async () => {
      const mock = installFetchMock(({ url }) => {
        expect(url).toContain('/write');
        return { ok: true, body: { id: 42, label: 'note' } };
      });
      try {
        const result = await ccmem.store('hello world', 'note');
        expect(result).toEqual({ id: 42, label: 'note' });
        expect(lastBody(mock.calls)).toEqual({ text: 'hello world', label: 'note' });
      } finally { mock.restore(); }
    });

    it('sends empty string for missing label (not null)', async () => {
      const mock = installFetchMock(() => ({ ok: true, body: { id: 1, label: '' } }));
      try {
        await ccmem.store('x');
        expect(lastBody(mock.calls).label).toBe('');
      } finally { mock.restore(); }
    });

    it('returns null without calling fetch when text is empty', async () => {
      const mock = installFetchMock(() => ({ ok: true, body: {} }));
      try {
        const result = await ccmem.store('   ');
        expect(result).toBeNull();
        expect(mock.calls).toHaveLength(0);
      } finally { mock.restore(); }
    });

    it('returns null on non-2xx response', async () => {
      const mock = installFetchMock(() => ({ ok: false }));
      try {
        const result = await ccmem.store('x');
        expect(result).toBeNull();
      } finally { mock.restore(); }
    });
  });

  describe('storeMany', () => {
    it('sends {items:[{text,label}]} to /write_many and returns ids', async () => {
      const mock = installFetchMock(({ url }) => {
        expect(url).toContain('/write_many');
        return { ok: true, body: { ids: [10, 11] } };
      });
      try {
        const ids = await ccmem.storeMany([
          { text: 'one', label: 'a' },
          { text: 'two' },
        ]);
        expect(ids).toEqual([10, 11]);
        expect(lastBody(mock.calls)).toEqual({
          items: [
            { text: 'one', label: 'a' },
            { text: 'two', label: '' },
          ],
        });
      } finally { mock.restore(); }
    });

    it('filters empty entries and returns [] when nothing left', async () => {
      const mock = installFetchMock(() => ({ ok: true, body: { ids: [] } }));
      try {
        const ids = await ccmem.storeMany([{ text: '' }, { text: '   ' }]);
        expect(ids).toEqual([]);
        expect(mock.calls).toHaveLength(0);
      } finally { mock.restore(); }
    });
  });

  describe('recall', () => {
    it('sends {text,top_k} to /query and returns hits with {id,label,source,margin}', async () => {
      const mock = installFetchMock(({ url }) => {
        expect(url).toContain('/query');
        return {
          ok: true,
          body: { hits: [{ id: 7, label: 'auth', source: 'JWT token...', margin: 0.42 }] },
        };
      });
      try {
        const hits = await ccmem.recall('how does auth work', 3);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toEqual({ id: 7, label: 'auth', source: 'JWT token...', margin: 0.42 });
        expect(lastBody(mock.calls)).toEqual({ text: 'how does auth work', top_k: 3 });
      } finally { mock.restore(); }
    });

    it('returns [] for empty query without calling fetch', async () => {
      const mock = installFetchMock(() => ({ ok: true, body: {} }));
      try {
        expect(await ccmem.recall('')).toEqual([]);
        expect(mock.calls).toHaveLength(0);
      } finally { mock.restore(); }
    });

    it('returns [] when service returns no hits', async () => {
      const mock = installFetchMock(() => ({ ok: true, body: {} }));
      try {
        expect(await ccmem.recall('x')).toEqual([]);
      } finally { mock.restore(); }
    });
  });

  describe('bind', () => {
    it('sends {texts,label} to /bind and returns {id,label,theta}', async () => {
      const mock = installFetchMock(({ url }) => {
        expect(url).toContain('/bind');
        return { ok: true, body: { id: 99, label: 'cluster', theta: 0.5 } };
      });
      try {
        const result = await ccmem.bind(['one', 'two', 'three'], 'cluster');
        expect(result).toEqual({ id: 99, label: 'cluster', theta: 0.5 });
        expect(lastBody(mock.calls)).toEqual({
          texts: ['one', 'two', 'three'],
          label: 'cluster',
        });
      } finally { mock.restore(); }
    });

    it('returns null when fewer than two non-empty texts are supplied', async () => {
      const mock = installFetchMock(() => ({ ok: true, body: {} }));
      try {
        expect(await ccmem.bind(['only'])).toBeNull();
        expect(await ccmem.bind(['one', '   '])).toBeNull();
        expect(mock.calls).toHaveLength(0);
      } finally { mock.restore(); }
    });
  });

  describe('setCcmemUrl', () => {
    it('uses the configured URL for subsequent requests', async () => {
      ccmem.setCcmemUrl('http://example.test:9999');
      const mock = installFetchMock(() => ({ ok: true, body: { id: 1, label: '' } }));
      try {
        await ccmem.store('hello');
        expect(mock.calls[0].url).toBe('http://example.test:9999/write');
      } finally { mock.restore(); }
    });
  });

  describe('auth token', () => {
    function lastHeaders(calls: FetchCall[]): Record<string, string> {
      const last = calls[calls.length - 1];
      return (last?.init?.headers ?? {}) as Record<string, string>;
    }

    afterEach(() => {
      // Clear the module-level token so it cannot leak into other suites.
      ccmem.setCcmemToken('');
    });

    it('sends Authorization: Bearer <token> on writes when configured', async () => {
      ccmem.setCcmemToken('secret-token');
      const mock = installFetchMock(() => ({ ok: true, body: { id: 1, label: '' } }));
      try {
        await ccmem.store('hello');
        expect(lastHeaders(mock.calls).Authorization).toBe('Bearer secret-token');
      } finally { mock.restore(); }
    });

    it('omits the Authorization header when no token is set', async () => {
      ccmem.setCcmemToken('');
      const mock = installFetchMock(() => ({ ok: true, body: { id: 1, label: '' } }));
      try {
        await ccmem.store('hello');
        expect(lastHeaders(mock.calls).Authorization).toBeUndefined();
      } finally { mock.restore(); }
    });

    it('sends the bearer token on the health probe too', async () => {
      ccmem.setCcmemToken('secret-token');
      const mock = installFetchMock(({ url }) => {
        expect(url).toContain('/health');
        return { ok: true, body: { status: 'ok' } };
      });
      try {
        await ccmem.isAvailable();
        expect(lastHeaders(mock.calls).Authorization).toBe('Bearer secret-token');
      } finally { mock.restore(); }
    });
  });
});
