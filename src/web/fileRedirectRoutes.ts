import express from 'express';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import {
  clearFileWriteRedirectCache,
  getFileWriteRedirects,
  previewFileWriteRedirect,
} from '../tools/pathResolution';

export interface FileRedirectRoutesDeps {
  projectDir: string;
}

// File-write redirect rules. Lets the user route any agent file_write
// whose path matches a glob into a specific directory (typically a
// sibling repo). Solves the recurring "another agent keeps dropping
// lottery scripts in the Harness root" problem at the tool layer
// rather than relying on .gitignore cleanup.
export function createFileRedirectRouter(deps: FileRedirectRoutesDeps): express.Router {
  const router = express.Router();
  const FILE_REDIRECTS_PATH = path.join(deps.projectDir, '.harness', 'file-write-redirects.json');

  router.get('/api/file-redirects', async (_req, res) => {
    try {
      const { rules, source } = getFileWriteRedirects();
      // Defense in depth: also report whether the env var is set so the
      // UI can show "managed by env var" and disable the editor if so.
      const envOverride = Boolean(process.env.HARNESS_FILE_WRITE_REDIRECTS?.trim());
      res.json({ rules, source, envOverride });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/file-redirects', async (req, res) => {
    try {
      const incoming = req.body && Array.isArray(req.body.rules) ? req.body.rules : null;
      if (!incoming) {
        res.status(400).json({ error: 'Body must be { rules: [...] }' });
        return;
      }
      // Validate + normalize each rule. Skip entries with empty match or
      // empty redirect rather than rejecting the whole payload — makes
      // the form forgiving when the user is mid-edit.
      const sanitized: Array<{ match: string; redirect: string }> = [];
      for (const entry of incoming) {
        if (!entry || typeof entry !== 'object') continue;
        const match = typeof entry.match === 'string' ? entry.match.trim() : '';
        const redirect = typeof entry.redirect === 'string' ? entry.redirect.trim() : '';
        if (!match || !redirect) continue;
        sanitized.push({ match, redirect });
      }
      await withFileLock(FILE_REDIRECTS_PATH, () => atomicWriteFile(FILE_REDIRECTS_PATH, JSON.stringify(sanitized, null, 2)));
      // Force the in-process cache to reload on the next file_write.
      clearFileWriteRedirectCache();
      res.json({ ok: true, count: sanitized.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Preview endpoint: takes ad-hoc rules + a sample path and returns
  // which rule (if any) would catch it and where the file would land.
  // Lets the user verify their rules before saving — catches typos like
  // `lottery_*` (underscore) when they meant `lottery-*` (hyphen). The
  // rules in the body are NOT persisted; this is read-only.
  router.post('/api/file-redirects/preview', async (req, res) => {
    try {
      const samplePath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      const rawRules = Array.isArray(req.body?.rules) ? req.body.rules : null;
      if (!samplePath || !rawRules) {
        res.status(400).json({ error: 'Body must be { path: string, rules: [...] }' });
        return;
      }
      const rules: Array<{ match: string; redirect: string }> = [];
      for (const entry of rawRules) {
        if (!entry || typeof entry !== 'object') continue;
        const match = typeof entry.match === 'string' ? entry.match.trim() : '';
        const redirect = typeof entry.redirect === 'string' ? entry.redirect.trim() : '';
        if (!match || !redirect) continue;
        rules.push({ match, redirect });
      }
      const result = previewFileWriteRedirect(samplePath, rules);
      if (result) {
        res.json({ matched: true, rule: result.rule, destination: result.destination });
      } else {
        res.json({ matched: false });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
