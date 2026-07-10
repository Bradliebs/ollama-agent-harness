import express from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface AssetRoutesDeps {
  projectDir: string;
}

export function createAssetRouter(deps: AssetRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/desktop-input/evidence', async (_req, res) => {
    try {
      const dir = path.join(projectDir, '.harness', 'desktop');
      const auditPath = path.join(dir, 'desktop-input-audit.jsonl');
      const auditRaw = await fs.readFile(auditPath, 'utf-8').catch(() => '');
      const audit = auditRaw.split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(-50)
        .map((line) => {
          try { return JSON.parse(line) as Record<string, unknown>; } catch { return { malformed: true, raw: line.slice(0, 500) }; }
        });
      const files = await fs.readdir(dir).catch(() => []);
      const screenshots = files
        .filter((name) => /^desktop-input-(before|after)-[A-Za-z0-9_.-]+\.png$/.test(name))
        .sort()
        .slice(-50)
        .map((name) => ({ name, url: `/api/desktop-input/evidence/file/${encodeURIComponent(name)}` }));
      res.json({ auditPath: '.harness/desktop/desktop-input-audit.jsonl', audit, screenshots });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/desktop-input/evidence/file/:name', (req, res) => {
    const name = String(req.params.name || '');
    if (!/^desktop-input-(before|after)-[A-Za-z0-9_.-]+\.png$/.test(name)) {
      res.status(404).json({ error: 'Desktop evidence file not found.' });
      return;
    }
    // dotfiles: 'allow' is required because the evidence lives under the
    // `.harness` dot-directory; sendFile defaults to `dotfiles: 'ignore'`,
    // which 404s any path containing a dot-segment even when the file exists.
    res.sendFile(path.join(projectDir, '.harness', 'desktop', name), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'Desktop evidence file not found.' });
      }
    });
  });

  router.get('/api/research/report/:name', (req, res) => {
    const name = String(req.params.name || '');
    // Slugs are sanitised to [a-z0-9-] before the .html suffix, so this also
    // blocks path traversal (no slashes or dots can appear in the name).
    if (!/^[a-z0-9][a-z0-9-]*\.html$/.test(name)) {
      res.status(404).json({ error: 'Research report not found.' });
      return;
    }
    res.sendFile(path.join(projectDir, '.harness', 'research', name), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'Research report not found. Re-run /research to regenerate it.' });
      }
    });
  });

  return router;
}
