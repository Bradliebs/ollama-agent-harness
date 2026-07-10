import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { evaluateCapabilityGrant, sanitizeCapabilityGrants } from '../permissions/capabilities';
import { recordBrowserAudit, type BrowserAuditInput } from './browserAudit';
import { getActiveSessionName, loadBrowserSessionState } from './browserSessions';

// ─── Browser page tools (Playwright-based) ─────────────────────────
//
// Navigate to URLs, read page content, click elements, fill forms,
// and take screenshots. High-risk: accesses the internet, can interact
// with live websites.
//
// Capability: browser-page-access (gated)
// Risk: high — navigates live websites, submits forms

type BrowserLaunchMode = 'headless' | 'headful' | 'persistent' | 'cdp';

let _pwBrowser: import('playwright').Browser | null = null;
let _pwContext: import('playwright').BrowserContext | null = null;
let _pwPage: import('playwright').Page | null = null;
let _pwBrowserCreatedAt = 0;
let _pwMode: BrowserLaunchMode = 'headless';
const BROWSER_MAX_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const BROWSER_SETTINGS_PATH = path.join('.harness', 'settings.json');

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

/**
 * Resolve the browser launch mode from env vars. Precedence: an explicit
 * CDP attach URL wins, then a persistent profile dir, then the headful
 * flag, otherwise the default headless fresh-profile launch (unchanged
 * behaviour when no env vars are set).
 *
 *   HARNESS_BROWSER_CDP_URL     attach to a Chrome started with
 *                               --remote-debugging-port (takes over the
 *                               user's already-running, logged-in browser)
 *   HARNESS_BROWSER_PROFILE_DIR launch a persistent profile so logins
 *                               survive across sessions
 *   HARNESS_BROWSER_HEADFUL     show a visible window (watch it click)
 *   HARNESS_BROWSER_CHANNEL     optional installed-browser channel, e.g.
 *                               "chrome" or "msedge" (default: bundled Chromium)
 */
function resolveLaunchMode(): BrowserLaunchMode {
  if ((process.env.HARNESS_BROWSER_CDP_URL ?? '').trim()) return 'cdp';
  if ((process.env.HARNESS_BROWSER_PROFILE_DIR ?? '').trim()) return 'persistent';
  if (isTruthyEnv(process.env.HARNESS_BROWSER_HEADFUL)) return 'headful';
  return 'headless';
}

function browserChannel(): string | undefined {
  const channel = (process.env.HARNESS_BROWSER_CHANNEL ?? '').trim();
  return channel || undefined;
}

async function getPlaywrightPage(): Promise<import('playwright').Page> {
  // Auto-close stale browsers to prevent resource leaks
  if ((_pwBrowser || _pwContext) && Date.now() - _pwBrowserCreatedAt > BROWSER_MAX_LIFETIME_MS) {
    await closeBrowser();
  }
  if (_pwPage && !_pwPage.isClosed()) return _pwPage;
  const pw = await import('playwright');
  const mode = resolveLaunchMode();
  _pwMode = mode;

  if (mode === 'cdp') {
    const cdpUrl = (process.env.HARNESS_BROWSER_CDP_URL ?? '').trim();
    _pwBrowser = await pw.chromium.connectOverCDP(cdpUrl);
    const contexts = _pwBrowser.contexts();
    const ctx = contexts.length > 0 ? contexts[0] : await _pwBrowser.newContext();
    const pages = ctx.pages();
    _pwPage = pages.length > 0 ? pages[0] : await ctx.newPage();
  } else if (mode === 'persistent') {
    const profileDir = (process.env.HARNESS_BROWSER_PROFILE_DIR ?? '').trim();
    _pwContext = await pw.chromium.launchPersistentContext(profileDir, {
      headless: !isTruthyEnv(process.env.HARNESS_BROWSER_HEADFUL),
      channel: browserChannel(),
    });
    const pages = _pwContext.pages();
    _pwPage = pages.length > 0 ? pages[0] : await _pwContext.newPage();
  } else {
    _pwBrowser = await pw.chromium.launch({ headless: mode === 'headless', channel: browserChannel() });
    // Cookie/session vault: when HARNESS_BROWSER_SESSION names a saved
    // login, restore it into a fresh context instead of relying on a raw
    // on-disk profile dir. With no session set this is bit-identical to
    // the previous `_pwBrowser.newPage()` default.
    const sessionName = getActiveSessionName();
    const sessionState = sessionName ? await loadBrowserSessionState(sessionName) : null;
    if (sessionState) {
      _pwContext = await _pwBrowser.newContext({
        storageState: sessionState as import('playwright').BrowserContextOptions['storageState'],
      });
      _pwPage = await _pwContext.newPage();
    } else {
      _pwPage = await _pwBrowser.newPage();
    }
  }
  _pwBrowserCreatedAt = Date.now();
  return _pwPage;
}

async function closeBrowser(): Promise<void> {
  // In CDP attach mode the browser belongs to the user — closing the page
  // would close their tab, so only disconnect (browser.close() on a CDP
  // connection disconnects Playwright without killing the user's Chrome).
  if (_pwPage && _pwMode !== 'cdp') { await _pwPage.close().catch(() => {}); }
  _pwPage = null;
  if (_pwContext) { await _pwContext.close().catch(() => {}); _pwContext = null; }
  if (_pwBrowser) { await _pwBrowser.close().catch(() => {}); _pwBrowser = null; }
  _pwMode = 'headless';
}

/**
 * Capture the current browser's `storageState` (cookies + per-origin
 * localStorage) for saving into the session vault. Returns null when no
 * browser context is live, so the caller can tell the user to open a
 * page first. CDP mode reuses the user's own context.
 */
export async function captureBrowserStorageState(): Promise<Record<string, unknown> | null> {
  const ctx = _pwContext ?? (_pwPage && !_pwPage.isClosed() ? _pwPage.context() : null);
  if (!ctx) return null;
  try {
    return await ctx.storageState() as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Append a redaction-safe audit entry for a browser page action. Stamps
 * the active launch mode and never throws (audit must not break a tool).
 */
async function audit(input: Omit<BrowserAuditInput, 'mode'>): Promise<void> {
  await recordBrowserAudit({ ...input, mode: _pwMode });
}

/**
 * Execution-time enforcement of the `browser-page-access` capability.
 * Mirrors the desktop-input tool: reads the persisted grant/kill-switch
 * state from .harness/settings.json so direct/CLI/cookbook call paths are
 * gated the same way the web chat loop's permissionCheck already gates them.
 */
async function requireBrowserPageGrant(): Promise<{ allowed: boolean; reason: string }> {
  const denyPrefix = 'Browser page tools require an active browser-page-access grant.';
  try {
    const raw = await fs.readFile(path.join(process.cwd(), BROWSER_SETTINGS_PATH), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const killSwitch = parsed.killSwitch && typeof parsed.killSwitch === 'object' ? parsed.killSwitch as Record<string, unknown> : {};
    const grants = sanitizeCapabilityGrants(parsed.capabilityGrants);
    const evaluation = evaluateCapabilityGrant('browser-page-access', grants, { killSwitchActive: Boolean(killSwitch.active) });
    if (evaluation.decision !== 'allow') {
      return { allowed: false, reason: `${denyPrefix} ${evaluation.reason}` };
    }
    return { allowed: true, reason: evaluation.reason };
  } catch {
    return { allowed: false, reason: `${denyPrefix} No grant settings found (.harness/settings.json).` };
  }
}

const MAX_TEXT_LENGTH = 8000;
const PAGE_TIMEOUT = 15_000;

/**
 * URL allowlist for browser navigation. When set, only URLs matching
 * these domain patterns are allowed. Configured via HARNESS_BROWSER_URL_ALLOWLIST
 * env var (comma-separated domains, e.g. "example.com,amazon.co.uk,*.gov.uk").
 * When empty, all URLs are allowed (subject to capability grants).
 */
function getUrlAllowlist(): string[] {
  const raw = process.env.HARNESS_BROWSER_URL_ALLOWLIST ?? '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isUrlAllowed(url: string): { allowed: boolean; reason: string } {
  const allowlist = getUrlAllowlist();
  if (allowlist.length === 0) return { allowed: true, reason: 'No URL allowlist configured.' };
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const pattern of allowlist) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        if (hostname === suffix || hostname.endsWith('.' + suffix)) return { allowed: true, reason: `Matches allowlist pattern *.${suffix}` };
      } else {
        if (hostname === pattern) return { allowed: true, reason: `Matches allowlist domain ${pattern}` };
      }
    }
    return { allowed: false, reason: `Domain "${hostname}" is not in the browser URL allowlist. Allowed: ${allowlist.join(', ')}` };
  } catch {
    return { allowed: false, reason: 'Invalid URL format.' };
  }
}

export const BrowserNavigateTool: Tool = {
  name: 'browser_navigate',
  description: 'Open a URL in a headless browser and return the page title and text content. Requires browser-page-access capability grant.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to navigate to' },
      wait_for: { type: 'string', description: 'Optional CSS selector to wait for before reading content' },
    },
    required: ['url'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = String(input.url ?? '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: false, output: 'A valid http/https URL is required.', error: 'invalid url' };
    }
    const urlCheck = isUrlAllowed(url);
    if (!urlCheck.allowed) {
      return { success: false, output: urlCheck.reason, error: 'url blocked' };
    }
    try {
      const grant = await requireBrowserPageGrant();
      if (!grant.allowed) {
        await audit({ tool: 'browser_navigate', url, outcome: 'error', detail: 'capability blocked' });
        return { success: false, output: grant.reason, error: 'capability blocked' };
      }
      const page = await getPlaywrightPage();
      await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
      const waitFor = typeof input.wait_for === 'string' ? input.wait_for.trim() : '';
      if (waitFor) await page.waitForSelector(waitFor, { timeout: PAGE_TIMEOUT }).catch(() => {});
      const title = await page.title();
      const text = await page.innerText('body').catch(() => '');
      const truncated = text.slice(0, MAX_TEXT_LENGTH);
      await audit({ tool: 'browser_navigate', url: page.url(), outcome: 'ok', detail: `${text.length} chars` });
      return { success: true, output: `📄 ${title}\n🔗 ${page.url()}\n\n${truncated}${text.length > MAX_TEXT_LENGTH ? '\n\n[...truncated]' : ''}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await audit({ tool: 'browser_navigate', url, outcome: 'error', detail: msg.slice(0, 200) });
      return { success: false, output: `Browser navigation failed: ${msg}`, error: msg };
    }
  },
};

export const BrowserClickTool: Tool = {
  name: 'browser_click',
  description: 'Click an element on the current browser page by CSS selector or text content. Requires browser-page-access capability grant.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the element to click' },
      text: { type: 'string', description: 'Visible text of the element to click (alternative to selector)' },
    },
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!selector && !text) {
      return { success: false, output: 'Provide either a CSS selector or text to click.', error: 'missing target' };
    }
    try {
      const grant = await requireBrowserPageGrant();
      if (!grant.allowed) {
        await audit({ tool: 'browser_click', target: selector || `text:${text}`, outcome: 'error', detail: 'capability blocked' });
        return { success: false, output: grant.reason, error: 'capability blocked' };
      }
      const page = await getPlaywrightPage();
      if (selector) {
        await page.click(selector, { timeout: PAGE_TIMEOUT });
      } else {
        await page.getByText(text, { exact: false }).first().click({ timeout: PAGE_TIMEOUT });
      }
      await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TIMEOUT }).catch(() => {});
      const title = await page.title();
      await audit({ tool: 'browser_click', target: selector || `text:${text}`, url: page.url(), outcome: 'ok' });
      return { success: true, output: `✅ Clicked ${selector || `text "${text}"`}\n📄 ${title}\n🔗 ${page.url()}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await audit({ tool: 'browser_click', target: selector || `text:${text}`, outcome: 'error', detail: msg.slice(0, 200) });
      return { success: false, output: `Click failed: ${msg}`, error: msg };
    }
  },
};

export const BrowserFillTool: Tool = {
  name: 'browser_fill',
  description: 'Fill a form field on the current browser page. Requires browser-page-access capability grant.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the input/textarea' },
      label: { type: 'string', description: 'Label text of the field (alternative to selector)' },
      value: { type: 'string', description: 'Value to type into the field' },
    },
    required: ['value'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    const value = String(input.value ?? '');
    if (!selector && !label) {
      return { success: false, output: 'Provide either a CSS selector or label for the field.', error: 'missing target' };
    }
    try {
      const grant = await requireBrowserPageGrant();
      if (!grant.allowed) {
        await audit({ tool: 'browser_fill', target: selector || `label:${label}`, outcome: 'error', detail: 'capability blocked' });
        return { success: false, output: grant.reason, error: 'capability blocked' };
      }
      const page = await getPlaywrightPage();
      if (selector) {
        await page.fill(selector, value, { timeout: PAGE_TIMEOUT });
      } else {
        await page.getByLabel(label, { exact: false }).first().fill(value, { timeout: PAGE_TIMEOUT });
      }
      await audit({ tool: 'browser_fill', target: selector || `label:${label}`, url: page.url(), outcome: 'ok', fillValue: value });
      return { success: true, output: `✅ Filled ${selector || `field "${label}"`} with "${value.slice(0, 100)}"` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await audit({ tool: 'browser_fill', target: selector || `label:${label}`, outcome: 'error', detail: msg.slice(0, 200) });
      return { success: false, output: `Fill failed: ${msg}`, error: msg };
    }
  },
};

export const BrowserReadTool: Tool = {
  name: 'browser_read',
  description: 'Read the current page content, title, and URL from the headless browser. Requires browser-page-access capability grant.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Optional CSS selector to read only that element\'s text' },
    },
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    try {
      const grant = await requireBrowserPageGrant();
      if (!grant.allowed) {
        await audit({ tool: 'browser_read', outcome: 'error', detail: 'capability blocked' });
        return { success: false, output: grant.reason, error: 'capability blocked' };
      }
      const page = await getPlaywrightPage();
      const title = await page.title();
      const url = page.url();
      const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
      let text: string;
      if (selector) {
        text = await page.locator(selector).first().innerText({ timeout: PAGE_TIMEOUT }).catch(() => '(element not found)');
      } else {
        text = await page.innerText('body').catch(() => '');
      }
      const truncated = text.slice(0, MAX_TEXT_LENGTH);
      await audit({ tool: 'browser_read', url, target: selector || 'body', outcome: 'ok', detail: `${text.length} chars` });
      return { success: true, output: `📄 ${title}\n🔗 ${url}\n\n${truncated}${text.length > MAX_TEXT_LENGTH ? '\n\n[...truncated]' : ''}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await audit({ tool: 'browser_read', outcome: 'error', detail: msg.slice(0, 200) });
      return { success: false, output: `Browser read failed: ${msg}`, error: msg };
    }
  },
};

export const BrowserScreenshotTool: Tool = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current browser page. Saves to .harness/browser/. Requires browser-page-access capability grant.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Output filename (default: page-screenshot.png)' },
      full_page: { type: 'boolean', description: 'Capture full scrollable page (default: false)' },
    },
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filename = typeof input.filename === 'string' ? input.filename.trim() : 'page-screenshot.png';
    const fullPage = input.full_page === true;
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const outDir = path.join(process.cwd(), '.harness', 'browser');
    const outPath = path.join(outDir, safeFilename);
    try {
      const grant = await requireBrowserPageGrant();
      if (!grant.allowed) {
        await audit({ tool: 'browser_screenshot', target: safeFilename, outcome: 'error', detail: 'capability blocked' });
        return { success: false, output: grant.reason, error: 'capability blocked' };
      }
      await fs.mkdir(outDir, { recursive: true });
      const page = await getPlaywrightPage();
      await page.screenshot({ path: outPath, fullPage });
      const title = await page.title();
      await audit({ tool: 'browser_screenshot', target: safeFilename, url: page.url(), outcome: 'ok' });
      return { success: true, output: `📸 Screenshot saved: ${outPath}\n📄 ${title}\n🔗 ${page.url()}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await audit({ tool: 'browser_screenshot', target: safeFilename, outcome: 'error', detail: msg.slice(0, 200) });
      return { success: false, output: `Screenshot failed: ${msg}`, error: msg };
    }
  },
};

export const BrowserCloseTool: Tool = {
  name: 'browser_close',
  description: 'Close the headless browser session. Call this when done with browser tasks to free resources.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  async execute(): Promise<ToolResult> {
    await closeBrowser();
    return { success: true, output: '✅ Browser session closed.' };
  },
};

// ─── Browser bookmarks tool ────────────────────────────────────────
//
// Reads bookmarks from Chrome or Edge browser profiles. Read-only
// access to bookmark titles and URLs — no cookies, sessions, or
// passwords are accessed.
//
// Capability: browser-profile-access (gated)
// Risk: medium — reads local profile data, but only bookmark metadata

interface Bookmark {
  name: string;
  url?: string;
  children?: Bookmark[];
}

export const BrowserBookmarksTool: Tool = {
  name: 'browser_bookmarks',
  description: 'Read bookmarks from Chrome or Edge browser profiles. Returns bookmark titles and URLs. Requires a browser-profile-access capability grant.',
  parameters: {
    type: 'object',
    properties: {
      browser: { type: 'string', description: 'Browser to read from: "chrome" (default) or "edge"' },
      folder: { type: 'string', description: 'Optional: filter to a specific bookmark folder name' },
      limit: { type: 'number', description: 'Maximum bookmarks to return (default 50)' },
    },
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const browser = String(input.browser ?? 'chrome').trim().toLowerCase();
    const folder = typeof input.folder === 'string' ? input.folder.trim() : '';
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));

    if (browser !== 'chrome' && browser !== 'edge') {
      return { success: false, output: 'Supported browsers: chrome, edge', error: 'unsupported browser' };
    }

    const bookmarksPath = getBookmarksPath(browser);
    if (!bookmarksPath) {
      return { success: false, output: `Could not find ${browser} bookmarks file on this platform.`, error: 'bookmarks not found' };
    }

    try {
      const raw = await fs.readFile(bookmarksPath, 'utf-8');
      const data = JSON.parse(raw) as { roots?: Record<string, unknown> };
      if (!data.roots) {
        return { success: false, output: 'Bookmarks file has unexpected format.', error: 'invalid format' };
      }

      const allBookmarks: Array<{ name: string; url: string; folder: string }> = [];
      for (const [rootName, rootValue] of Object.entries(data.roots)) {
        flattenBookmarks(rootValue as Record<string, unknown>, rootName, allBookmarks);
      }

      let filtered = allBookmarks;
      if (folder) {
        const folderLower = folder.toLowerCase();
        filtered = allBookmarks.filter((b) => b.folder.toLowerCase().includes(folderLower));
      }

      const limited = filtered.slice(0, limit);
      if (limited.length === 0) {
        return { success: true, output: folder ? `No bookmarks found in folder "${folder}".` : 'No bookmarks found.' };
      }

      const output = limited.map((b) => `${b.name} — ${b.url} [${b.folder}]`).join('\n');
      return {
        success: true,
        output: `Found ${filtered.length} bookmark(s)${filtered.length > limit ? ` (showing first ${limit})` : ''}:\n\n${output}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read bookmarks: ${msg}`, error: msg };
    }
  },
};

function getBookmarksPath(browser: 'chrome' | 'edge'): string | null {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    if (browser === 'chrome') return path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks');
    return path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks');
  }
  if (platform === 'darwin') {
    if (browser === 'chrome') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Bookmarks');
    return path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Bookmarks');
  }
  if (platform === 'linux') {
    if (browser === 'chrome') return path.join(home, '.config', 'google-chrome', 'Default', 'Bookmarks');
    return path.join(home, '.config', 'microsoft-edge', 'Default', 'Bookmarks');
  }
  return null;
}

function flattenBookmarks(node: Record<string, unknown>, folderPath: string, result: Array<{ name: string; url: string; folder: string }>): void {
  if (typeof node !== 'object' || node === null) return;
  const type = String(node.type ?? '');

  if (type === 'url' && typeof node.url === 'string') {
    result.push({
      name: String(node.name ?? '').slice(0, 200),
      url: String(node.url).slice(0, 2000),
      folder: folderPath,
    });
  }

  if (type === 'folder' && Array.isArray(node.children)) {
    const name = String(node.name ?? folderPath);
    for (const child of node.children) {
      flattenBookmarks(child as Record<string, unknown>, `${folderPath}/${name}`, result);
    }
  }
}
