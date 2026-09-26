/// <reference types="jest" />

import { configureWebReadTool, WebReadTool } from './webSearchTool';

describe('WebReadTool weather fallback', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    configureWebReadTool({ maxChars: 12_000 });
    jest.restoreAllMocks();
  });

  it('adds weather fallback search snippets when forecast page text is sparse', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('<html><head><title>Bracknell weather forecast - Met Office</title></head><body><main>Maps & charts<br>Climate<br>Specialist forecasts</main></body></html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('<div class="result "><a class="result__a" href="https://example.test/weather">Generic Bracknell weather today</a><a class="result__snippet">Weather map and adverts.</a></div><div class="result "><a class="result__a" href="https://weather.metoffice.gov.uk/forecast/gcpkqzuj9">Bracknell weather today</a><a class="result__snippet">Sunny intervals and light winds.</a></div>', { headers: { 'content-type': 'text/html' } }));

    const result = await WebReadTool.execute({ url: 'https://weather.metoffice.gov.uk/forecast/gcpkqzuj9' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('[Weather fallback]');
    expect(result.output).toContain('Bracknell weather today [official forecast]');
    expect(result.output).toContain('Sunny intervals and light winds.');
  });

  it('does not add weather fallback for rich non-weather pages', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('<html><body><main><h1>Release notes</h1><p>' + 'Detailed content. '.repeat(80) + '</p></main></body></html>', { headers: { 'content-type': 'text/html' } }));

    const result = await WebReadTool.execute({ url: 'https://example.test/release-notes' });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('[Weather fallback]');
  });

  it('truncates large readable pages to the web_read context budget', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('<html><body><main><h1>Large story</h1><p>' + 'Detailed paragraph. '.repeat(1200) + '</p></main></body></html>', { headers: { 'content-type': 'text/html' } }));

    const result = await WebReadTool.execute({ url: 'https://example.test/large-story' });

    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(13_000);
    expect(result.output).toContain('truncated to 12000 chars by web_read context budget');
  });

  it('honors a configured web_read context budget', async () => {
    configureWebReadTool({ maxChars: 2_000 });
    global.fetch = jest.fn().mockResolvedValue(new Response('<html><body><main><h1>Large story</h1><p>' + 'Detailed paragraph. '.repeat(500) + '</p></main></body></html>', { headers: { 'content-type': 'text/html' } }));

    const result = await WebReadTool.execute({ url: 'https://example.test/large-story' });

    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(2_800);
    expect(result.output).toContain('truncated to 2000 chars by web_read context budget');
  });
});

describe('WebReadTool blocked-site handling', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const page = () => new Response('<html><body><main><h1>Story title here</h1><p>' + 'Body text. '.repeat(80) + '</p></main></body></html>', { headers: { 'content-type': 'text/html' } });

  it('sends browser-like headers instead of a bot user agent', async () => {
    const fetchMock = jest.fn().mockResolvedValue(page());
    global.fetch = fetchMock;

    await WebReadTool.execute({ url: 'https://example.test/story' });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/Mozilla\/5\.0 \(Windows NT/);
    expect(headers['User-Agent']).not.toMatch(/OllamaHarness/);
    expect(headers['Accept-Language']).toBeTruthy();
  });

  it('retries once with alternate headers after a 403 and returns the page', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403, statusText: 'Forbidden' }))
      .mockResolvedValueOnce(page());
    global.fetch = fetchMock;

    const result = await WebReadTool.execute({ url: 'https://example.test/story' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>)['User-Agent']).toMatch(/Macintosh/);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Story title here');
  });

  it('returns an actionable error when the site still blocks the retry', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('denied', { status: 403, statusText: 'Forbidden' }));

    const result = await WebReadTool.execute({ url: 'https://example.test/story' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 403');
    expect(result.output).toMatch(/^HTTP 403 Forbidden/);
    expect(result.output).toContain('use a different search result');
  });

  it('does not retry a 404', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('missing', { status: 404, statusText: 'Not Found' }));

    const result = await WebReadTool.execute({ url: 'https://example.test/missing' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: false, output: 'HTTP 404 Not Found', error: 'HTTP 404' });
  });
});