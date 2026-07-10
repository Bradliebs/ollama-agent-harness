import express from 'express';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface FileBrowseRoutesDeps {
  projectDir: string;
}

export function createFileBrowseRouter(deps: FileBrowseRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  function resolveProjectPath(value: string): string | null {
    const resolved = path.resolve(value);
    const relative = path.relative(projectDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return resolved;
  }

  router.get('/api/files', async (req, res) => {
    const dir = resolveProjectPath((req.query.path as string) || projectDir);
    if (!dir) { res.status(400).json({ error: 'Path is outside the project directory.' }); return; }
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
        .map(e => {
          const absolute = path.join(dir, e.name);
          const relative = path.relative(projectDir, absolute).split(path.sep).join('/');
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: absolute, relative };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      res.json({ items, cwd: dir, projectDir });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // Lists subdirectories of any path on disk so the user can navigate to
  // the destination folder for agent file_write outputs without typing.
  // NOT confined to projectDir — the whole point is the user picking a
  // folder OUTSIDE the project (e.g. C:/AI/Lottery-Toolkit/inbox).
  router.get('/api/browse-dirs', async (req, res) => {
    try {
      const queryPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
      const home = os.homedir();
      const cwd = queryPath
        ? path.resolve(queryPath)
        : home;
      let parent: string | null = path.dirname(cwd);
      if (parent === cwd) parent = null;
      const presets: Array<{ label: string; path: string }> = [
        { label: 'Home', path: home },
        { label: 'Desktop', path: path.join(home, 'Desktop') },
        { label: 'Documents', path: path.join(home, 'Documents') },
        { label: 'Downloads', path: path.join(home, 'Downloads') },
        { label: 'Project root', path: projectDir },
        { label: 'agent-outputs (default)', path: path.join(projectDir, 'agent-outputs') },
      ];
      let dirs: Array<{ name: string; path: string }> = [];
      try {
        const entries = await fs.readdir(cwd, { withFileTypes: true });
        dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: path.join(cwd, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) {
        // If the path is unreadable (permission denied, doesn't exist), still
        // return the presets so the UI stays useful.
        const msg = error instanceof Error ? error.message : String(error);
        res.json({ cwd, parent, presets, dirs: [], error: msg });
        return;
      }
      res.json({ cwd, parent, presets, dirs });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
