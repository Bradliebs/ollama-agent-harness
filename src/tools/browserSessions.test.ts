import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  saveBrowserSession,
  listBrowserSessions,
  loadBrowserSessionState,
  deleteBrowserSession,
  getActiveSessionName,
} from './browserSessions';

describe('browserSessions vault', () => {
  let originalCwd: string;
  let tmpDir: string;

  const sampleState = {
    cookies: [
      { name: 'sid', value: 'super-secret-token', domain: '.example.com', path: '/' },
      { name: 'csrf', value: 'abc', domain: '.example.com', path: '/' },
    ],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'harness-sessions-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists empty when no sessions saved', async () => {
    expect(await listBrowserSessions()).toEqual([]);
  });

  it('saves and lists metadata without exposing cookie values', async () => {
    const meta = await saveBrowserSession('github-login', sampleState);
    expect(meta.name).toBe('github-login');
    expect(meta.cookieCount).toBe(2);
    expect(meta.originCount).toBe(1);

    const list = await listBrowserSessions();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('github-login');
    expect(list[0].cookieCount).toBe(2);
    // Metadata must never carry the raw login material.
    expect(JSON.stringify(list)).not.toContain('super-secret-token');
  });

  it('round-trips storage state for restoring into a context', async () => {
    await saveBrowserSession('acct', sampleState);
    const state = await loadBrowserSessionState('acct');
    expect(state).not.toBeNull();
    expect(JSON.stringify(state)).toContain('super-secret-token');
  });

  it('sanitizes names so they cannot escape the vault directory', async () => {
    await saveBrowserSession('../../etc/passwd', sampleState);
    const files = await fsPromises.readdir(path.join(tmpDir, '.harness', 'browser-sessions'));
    expect(files.every((f) => !f.includes('/') && !f.includes('\\'))).toBe(true);
    expect(files.some((f) => f.includes('etc') && f.endsWith('.json'))).toBe(true);
  });

  it('deletes a session', async () => {
    await saveBrowserSession('temp', sampleState);
    expect(await deleteBrowserSession('temp')).toBe(true);
    expect(await listBrowserSessions()).toEqual([]);
    expect(await deleteBrowserSession('temp')).toBe(false);
  });

  it('reads the active session name from env', () => {
    const original = process.env.HARNESS_BROWSER_SESSION;
    try {
      process.env.HARNESS_BROWSER_SESSION = '  work  ';
      expect(getActiveSessionName()).toBe('work');
      delete process.env.HARNESS_BROWSER_SESSION;
      expect(getActiveSessionName()).toBe('');
    } finally {
      if (original === undefined) delete process.env.HARNESS_BROWSER_SESSION;
      else process.env.HARNESS_BROWSER_SESSION = original;
    }
  });
});
