import express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

// Preview of web pages the agent wrote (index.html and the CSS, JS and images
// next to it), shown in the chat's artifact panel or a new tab.
//
// Serving project files from the UI's own origin is risky: a page could call
// the harness API as if it were the UI. So every response carries a CSP
// `sandbox` header (without allow-same-origin), which gives the page an opaque
// origin even when opened in its own tab. Each page gets a random token, handed
// out only by the authenticated /api/preview-link, that serves just the page's
// own folder; paths are confined like the file tools' (project directory and
// allowed folders, after resolving symlinks, with no dot-folders such as
// .harness or .git below them).
//
// Because the page's origin is opaque, its fetch() calls and module scripts
// are cross-origin requests, so responses allow any origin. That lets the page
// (and any script it loads from a CDN) read the files in its own folder. Not
// for a page directly in the project or an allowed folder, whose folder is the
// whole tree: such a page gets classic scripts and CSS only.

export interface PreviewRoutesDeps {
  /** The file tools' path confinement: an absolute path inside the project or an allowed folder, or null. */
  resolvePath: (value: string) => string | null;
  /** The folders resolvePath allows (project directory and allowed external folders); hidden folders are checked only below them. */
  roots: () => string[];
}

const PREVIEWABLE_ENTRY = /\.html?$/i;
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_PREVIEW_FOLDERS = 200;
const SANDBOX_POLICY = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * No dot-folders or dotfiles (.harness, .git, .env, …) below the allowed folder
 * that holds the path. Folders above it may be hidden (a project in ~/.local).
 */
function hasHiddenSegment(absolute: string, roots: string[]): boolean {
  const below = roots
    .map((root) => path.relative(path.resolve(root), absolute))
    .filter((relative) => !relative.startsWith('..') && !path.isAbsolute(relative))
    .sort((a, b) => a.length - b.length)[0];
  if (below === undefined) return true;
  return below.split(/[\\/]/).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

export function createPreviewRouter(deps: PreviewRoutesDeps): express.Router {
  const router = express.Router();
  // token -> real folder of a previewed page, and back; oldest dropped first.
  const folders = new Map<string, string>();
  const tokens = new Map<string, string>();

  function tokenFor(folder: string): string {
    const existing = tokens.get(folder);
    if (existing) return existing;
    const token = crypto.randomBytes(24).toString('base64url');
    folders.set(token, folder);
    tokens.set(folder, token);
    if (folders.size > MAX_PREVIEW_FOLDERS) {
      const [oldToken, oldFolder] = folders.entries().next().value as [string, string];
      folders.delete(oldToken);
      tokens.delete(oldFolder);
    }
    return token;
  }

  /**
   * The real path of a file the preview may serve: inside an allowed folder
   * after resolving links, with nothing hidden below it, within the size cap.
   * `resolved` is already confined (by resolvePath, or to a previewed page's folder).
   */
  async function realRoots(): Promise<string[]> {
    return Promise.all(deps.roots().map((root) => fs.realpath(root).catch(() => path.resolve(root))));
  }

  async function previewableFile(resolved: string): Promise<string | null> {
    try {
      const real = await fs.realpath(resolved);
      const roots = await realRoots();
      if (hasHiddenSegment(real, roots)) return null;
      const stat = await fs.stat(real);
      return stat.isFile() && stat.size <= MAX_PREVIEW_BYTES ? real : null;
    } catch {
      return null;
    }
  }

  router.get('/api/preview-link', async (req, res) => {
    const requested = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!requested || !PREVIEWABLE_ENTRY.test(requested)) {
      res.status(400).json({ error: 'Only .html files can be previewed.' });
      return;
    }
    const resolved = deps.resolvePath(requested);
    const file = resolved && !hasHiddenSegment(resolved, deps.roots()) ? await previewableFile(resolved) : null;
    if (!file) {
      res.status(404).json({ error: 'That file was not found, or it is outside the folders the agent may use.' });
      return;
    }
    res.json({ url: `/preview/${tokenFor(path.dirname(file))}/${encodeURIComponent(path.basename(file))}`, path: file });
  });

  router.get('/preview/:token/*splat', async (req, res) => {
    const notFound = (): void => { res.status(404).type('text/plain').send('Not found'); };
    const folder = folders.get(String(req.params.token));
    const rest = (req.params as unknown as { splat?: string[] }).splat ?? [];
    if (!folder || rest.length === 0) { notFound(); return; }
    // Only files at or below the page's folder, before and after resolving links.
    const target = path.resolve(folder, ...rest);
    if (target === folder || !isWithin(folder, target)) { notFound(); return; }
    const file = await previewableFile(target);
    if (!file || file === folder || !isWithin(folder, file)) { notFound(); return; }
    res.setHeader('Content-Security-Policy', SANDBOX_POLICY);
    if (!(await realRoots()).some((root) => path.relative(root, folder) === '')) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    // With root set, send's dotfile check covers only the path below the page folder.
    res.sendFile(path.relative(folder, file), { root: folder, dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) notFound();
    });
  });

  return router;
}