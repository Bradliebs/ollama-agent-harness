import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createPreviewRouter } from './previewRoutes';

describe('preview routes', () => {
  let base: string;
  let root: string;
  let outside: string;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-root-'));
    // The project itself sits under a dot-folder (like ~/.local/...), which must not block previews.
    root = path.join(base, '.dotted', 'project');
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-outside-'));
    fs.mkdirSync(path.join(root, 'site', 'js'), { recursive: true });
    fs.mkdirSync(path.join(root, 'site', '.cache'), { recursive: true });
    fs.mkdirSync(path.join(root, 'other'), { recursive: true });
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, 'site', 'index.html'), '<html><link rel="stylesheet" href="style.css"><script src="js/app.js"></script></html>');
    fs.writeFileSync(path.join(root, 'site', 'style.css'), 'body { color: red }');
    fs.writeFileSync(path.join(root, 'site', 'js', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'site', '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(root, 'site', '.cache', 'page.html'), '<p>cached</p>');
    fs.writeFileSync(path.join(root, 'other', 'page.html'), '<p>other</p>');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'top secret');
    fs.writeFileSync(path.join(root, 'home.html'), '<p>home</p>');
    fs.writeFileSync(path.join(root, '.harness', 'page.html'), '<p>state</p>');
    fs.writeFileSync(path.join(outside, 'index.html'), '<p>outside</p>');
    // A link inside the project to a folder outside it (a junction needs no admin rights on Windows).
    fs.symlinkSync(outside, path.join(root, 'site', 'linked'), 'junction');
    const resolvePath = (value: string): string | null => {
      const resolved = path.resolve(root, value);
      const relative = path.relative(root, resolved);
      return relative.startsWith('..') || path.isAbsolute(relative) ? null : resolved;
    };
    const app = express();
    app.use(createPreviewRouter({ resolvePath, roots: () => [root] }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Remove the link itself first, so the recursive delete can't follow it.
    fs.unlinkSync(path.join(root, 'site', 'linked'));
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const link = async (file: string) => fetch(`${origin}/api/preview-link?path=${encodeURIComponent(file)}`);
  const folderOf = async (file: string): Promise<string> => {
    const { url } = await (await link(file)).json() as { url: string };
    return url.slice(0, url.lastIndexOf('/'));
  };

  it('serves a written page and the files next to it inside a sandbox', async () => {
    const response = await link('site/index.html');
    expect(response.status).toBe(200);
    const { url } = await response.json() as { url: string };
    expect(url).toMatch(/^\/preview\/[A-Za-z0-9_-]{32}\/index\.html$/);
    expect(await folderOf('site/index.html')).toBe(url.slice(0, url.lastIndexOf('/')));

    const page = await fetch(origin + url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(page.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    // The page's own fetch() and module scripts come from an opaque origin.
    expect(page.headers.get('access-control-allow-origin')).toBe('*');

    const folder = url.slice(0, url.lastIndexOf('/'));
    expect((await fetch(`${origin}${folder}/style.css`)).status).toBe(200);
    expect(await (await fetch(`${origin}${folder}/js/app.js`)).text()).toBe('console.log(1)');
  });

  it('does not let a page at the project root read the whole project from scripts', async () => {
    const { url } = await (await link('home.html')).json() as { url: string };
    const page = await fetch(origin + url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(page.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves only the page folder: not hidden files, parents, siblings, links out, or unknown tokens', async () => {
    const folder = await folderOf('site/index.html');
    expect((await fetch(`${origin}${folder}/.env`)).status).toBe(404);
    expect((await fetch(`${origin}${folder}/.cache/page.html`)).status).toBe(404);
    expect((await fetch(`${origin}${folder}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${origin}${folder}/..%2fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${origin}${folder}/..%2fother%2fpage.html`)).status).toBe(404);
    expect((await fetch(`${origin}${folder}/linked/index.html`)).status).toBe(404);
    expect((await fetch(`${origin}/preview/not-a-real-token/index.html`)).status).toBe(404);
  });

  it('hands out links only for allowed .html files', async () => {
    expect((await link('secret.txt')).status).toBe(400);
    expect((await link('.harness/page.html')).status).toBe(404);
    expect((await link('site/.cache/page.html')).status).toBe(404);
    expect((await link('site/linked/index.html')).status).toBe(404);
    expect((await link(path.join(outside, 'index.html'))).status).toBe(404);
    expect((await link('site/missing.html')).status).toBe(404);
    expect((await link('other/page.html')).status).toBe(200);
  });
});