import express from 'express';
import {
  applyMergeProposal,
  clearCuratorProposals,
  parseMergeProposals,
  readCuratorProposals,
  restoreSkill,
} from '../curator/curator';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && SAFE_ID_PATTERN.test(id) ? id : null;
}

export interface CuratorStatus {
  settings: unknown;
  lastUserActivityAt: string;
  schedulerRunning: boolean;
  log: unknown[];
  proposals: string | null;
  archived: string[];
}

export interface CuratorRouterDeps {
  projectDir: string;
  getCuratorStatus: () => Promise<CuratorStatus>;
  runCuratorPreview: () => Promise<unknown>;
  runCuratorPhase: () => Promise<unknown>;
}

export function createCuratorRouter(deps: CuratorRouterDeps): express.Router {
  const router = express.Router();

  router.get('/api/curator', async (_req, res) => {
    try {
      res.json(await deps.getCuratorStatus());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/curator/preview', async (_req, res) => {
    try {
      const summary = await deps.runCuratorPreview();
      res.json({ summary });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/curator/run', async (_req, res) => {
    try {
      const summary = await deps.runCuratorPhase();
      res.json({ summary });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/curator/restore/:name', async (req, res) => {
    const skillName = safeLocalId(req.params.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    try {
      const result = await restoreSkill(deps.projectDir, skillName);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/curator/proposals', async (_req, res) => {
    try {
      const raw = await readCuratorProposals(deps.projectDir);
      const proposals = raw ? parseMergeProposals(raw) : [];
      res.json({ proposals, raw });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/curator/proposals/apply', async (req, res) => {
    const proposal = req.body?.proposal;
    if (!proposal || !Array.isArray(proposal.mergeSkills) || proposal.mergeSkills.length < 2) {
      res.status(400).json({ error: 'proposal must include at least 2 mergeSkills' });
      return;
    }
    const opts = {
      umbrellaName: typeof req.body?.umbrellaName === 'string' ? req.body.umbrellaName : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description : undefined,
      dryRun: Boolean(req.body?.dryRun),
    };
    try {
      const result = await applyMergeProposal(deps.projectDir, {
        umbrellaName: typeof proposal.umbrellaName === 'string' ? proposal.umbrellaName : 'umbrella',
        heading: typeof proposal.heading === 'string' ? proposal.heading : '',
        mergeSkills: proposal.mergeSkills.map((item: unknown) => String(item)),
        rationale: typeof proposal.rationale === 'string' ? proposal.rationale : undefined,
        proposedDescription: typeof proposal.proposedDescription === 'string' ? proposal.proposedDescription : undefined,
      }, opts);
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/curator/proposals', async (_req, res) => {
    try {
      await clearCuratorProposals(deps.projectDir);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
