import { BrowserNavigateTool, BrowserClickTool, BrowserFillTool, BrowserReadTool, BrowserScreenshotTool, BrowserCloseTool, BrowserBookmarksTool } from './browserTools';

// Browser page tools require Playwright with Chromium installed.
// These tests validate input validation and error handling without
// launching a real browser — the Playwright import fails gracefully
// in CI environments without browsers.

describe('BrowserNavigateTool', () => {
  it('rejects missing URL', async () => {
    const result = await BrowserNavigateTool.execute({});
    expect(result.success).toBe(false);
    expect(result.output).toContain('valid http/https URL');
  });

  it('rejects non-http URL', async () => {
    const result = await BrowserNavigateTool.execute({ url: 'ftp://example.com' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('valid http/https URL');
  });

  it('rejects empty URL', async () => {
    const result = await BrowserNavigateTool.execute({ url: '  ' });
    expect(result.success).toBe(false);
  });
});

describe('BrowserClickTool', () => {
  it('rejects when neither selector nor text provided', async () => {
    const result = await BrowserClickTool.execute({});
    expect(result.success).toBe(false);
    expect(result.output).toContain('selector or text');
  });
});

describe('BrowserFillTool', () => {
  it('rejects when neither selector nor label provided', async () => {
    const result = await BrowserFillTool.execute({ value: 'hello' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('selector or label');
  });
});

describe('BrowserReadTool', () => {
  it('has correct metadata', () => {
    expect(BrowserReadTool.name).toBe('browser_read');
    expect(BrowserReadTool.isReadOnly).toBe(true);
  });
});

describe('BrowserScreenshotTool', () => {
  it('has correct metadata', () => {
    expect(BrowserScreenshotTool.name).toBe('browser_screenshot');
    expect(BrowserScreenshotTool.isReadOnly).toBe(true);
  });
});

describe('BrowserCloseTool', () => {
  it('succeeds even when no browser is open', async () => {
    const result = await BrowserCloseTool.execute({});
    expect(result.success).toBe(true);
    expect(result.output).toContain('closed');
  });
});

describe('BrowserBookmarksTool', () => {
  it('rejects unsupported browser', async () => {
    const result = await BrowserBookmarksTool.execute({ browser: 'firefox' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Supported browsers');
  });
});
