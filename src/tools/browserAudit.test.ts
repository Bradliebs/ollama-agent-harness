import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { recordBrowserAudit, readBrowserAudit } from './browserAudit';

// All tests run inside a temp working dir so reads/writes of
// .harness/browser-audit.jsonl and .harness/settings.json are isolated
// from the repo and from each other.
describe('browserAudit', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'harness-audit-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeRedaction(redaction: unknown): Promise<void> {
    await fsPromises.mkdir(path.join(tmpDir, '.harness'), { recursive: true });
    await fsPromises.writeFile(
      path.join(tmpDir, '.harness', 'settings.json'),
      JSON.stringify({ browserRedaction: redaction }),
    );
  }

  it('returns an empty list when no log exists', async () => {
    expect(await readBrowserAudit()).toEqual([]);
  });

  it('appends entries and reads them back newest-first', async () => {
    await recordBrowserAudit({ tool: 'browser_navigate', mode: 'headless', url: 'https://a.example/1', outcome: 'ok', detail: '10 chars' });
    await recordBrowserAudit({ tool: 'browser_read', mode: 'headless', url: 'https://a.example/2', outcome: 'ok', detail: '20 chars' });
    const entries = await readBrowserAudit();
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe('browser_read');
    expect(entries[1].tool).toBe('browser_navigate');
    expect(typeof entries[0].ts).toBe('string');
  });

  it('redacts fill values by default', async () => {
    await recordBrowserAudit({ tool: 'browser_fill', mode: 'headless', target: 'label:Password', outcome: 'ok', fillValue: 'hunter2secret' });
    const [entry] = await readBrowserAudit();
    expect(entry.detail).toContain('[redacted len=13]');
    expect(entry.detail).not.toContain('hunter2secret');
  });

  it('keeps fill values when redactValues is disabled', async () => {
    await writeRedaction({ redactValues: false, urlMode: 'full' });
    await recordBrowserAudit({ tool: 'browser_fill', mode: 'headless', target: 'label:Search', outcome: 'ok', fillValue: 'kettle' });
    const [entry] = await readBrowserAudit();
    expect(entry.detail).toContain('kettle');
  });

  it('narrows URLs to origin when urlMode is origin', async () => {
    await writeRedaction({ redactValues: true, urlMode: 'origin' });
    await recordBrowserAudit({ tool: 'browser_navigate', mode: 'headless', url: 'https://shop.example/checkout?token=abc123', outcome: 'ok' });
    const [entry] = await readBrowserAudit();
    expect(entry.url).toBe('https://shop.example');
    expect(entry.url).not.toContain('token');
  });

  it('keeps full URLs by default', async () => {
    await recordBrowserAudit({ tool: 'browser_navigate', mode: 'headless', url: 'https://shop.example/checkout?id=5', outcome: 'ok' });
    const [entry] = await readBrowserAudit();
    expect(entry.url).toBe('https://shop.example/checkout?id=5');
  });
});
