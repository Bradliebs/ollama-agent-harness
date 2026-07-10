import { promises as fs } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getAgentOutputDir } from '../tools/pathResolution';
import { logger } from '../core/logger';

export interface SaveOutputRoutesDeps {
  projectDir: string;
}

const SAVE_OUTPUT_MAX_BYTES = 1_000_000;

async function fileExists(fp: string): Promise<boolean> {
  try { await fs.access(fp); return true; } catch { return false; }
}

export function createSaveOutputRouter(deps: SaveOutputRoutesDeps): express.Router {
  const { projectDir } = deps;
  const router = express.Router();

  router.post('/api/save-output', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (!content) { res.status(400).json({ error: 'content is required' }); return; }
      if (Buffer.byteLength(content, 'utf-8') > SAVE_OUTPUT_MAX_BYTES) {
        res.status(413).json({ error: `content exceeds ${SAVE_OUTPUT_MAX_BYTES} byte cap` });
        return;
      }
      const requested = typeof req.body?.filename === 'string' ? req.body.filename.trim() : '';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fallback = `reply-${stamp}.md`;
      const baseRaw = requested ? path.basename(requested) : fallback;
      const safeBase = baseRaw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || fallback;
      const outDir = getAgentOutputDir();
      await fs.mkdir(outDir, { recursive: true });
      const ext = path.extname(safeBase);
      const stem = ext ? safeBase.slice(0, -ext.length) : safeBase;
      let candidate = path.join(outDir, safeBase);
      let suffix = 2;
      while (await fileExists(candidate)) {
        candidate = path.join(outDir, `${stem}-${suffix}${ext || '.md'}`);
        suffix += 1;
        if (suffix > 100) { res.status(500).json({ error: 'Could not allocate a unique filename' }); return; }
      }
      await fs.writeFile(candidate, content, 'utf-8');
      const rel = path.relative(projectDir, candidate).split(path.sep).join('/');
      logger.info('SaveOutput', `Saved chat output → ${rel} (${Buffer.byteLength(content, 'utf-8')} bytes)`);
      res.json({ path: candidate, relativePath: rel.startsWith('..') ? candidate : rel, name: path.basename(candidate), bytes: Buffer.byteLength(content, 'utf-8') });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
