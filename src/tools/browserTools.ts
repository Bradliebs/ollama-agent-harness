import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

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
