import express from 'express';
import * as path from 'path';
import { promises as fs } from 'fs';
import { logger } from '../core/logger';
import {
  createAutomationJob,
  deleteAutomationJob,
  executeDueJobs,
  listAutomationJobs,
  parseAutomationSchedule,
  computeNextAutomationRun,
  readAutomationRunLog,
  updateAutomationJob,
} from '../automation/jobs';
import { auditAutomationJobSafety } from '../automation/jobSafety';
import { prepareAutomationRun } from '../automation/runner';
import { listOrphanedRuns } from '../automation/jobLedger';
import { appendRunEvidence, readRunEvidence, type StoredRunEvidence } from '../persistence/evidenceStore';

type PolicyContext = Parameters<typeof executeDueJobs>[1];

function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && /^[a-zA-Z0-9._-]+$/.test(id) ? id : null;
}

export interface AutomationRouterDeps {
  projectDir: string;
  ensureSettingsLoaded: () => Promise<void>;
  isKillSwitchActive: () => boolean;
  getPolicyContext: () => PolicyContext;
  /** Build a StoredRunEvidence card. Closes over module-level model/permission state. */
  buildEvidenceCard: (input: {
    id: string;
    kind: 'automation';
    request: string;
    runName?: string;
    command?: string;
    outputPath?: string;
    success?: boolean;
    summary?: string;
  }) => StoredRunEvidence;
  /** Fire-and-forget notification after a batch of automations completes. */
  notifyAutomationCompleted: (results: Array<{ jobId: string; name: string }>) => void;
}

export function createAutomationRouter(deps: AutomationRouterDeps): express.Router {
  const router = express.Router();

  router.post('/api/automations/execute-due', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      if (deps.isKillSwitchActive()) {
        res.status(403).json({ error: 'Kill switch is active.', results: [] });
        return;
      }
      const policy = deps.getPolicyContext();
      const results = await executeDueJobs(deps.projectDir, policy);
      const evidence: StoredRunEvidence[] = [];
      for (const result of results) {
        const card = deps.buildEvidenceCard({
          id: `automation:${result.jobId}:${new Date().toISOString()}`,
          kind: 'automation',
          request: result.run.prompt,
          runName: result.name,
          command: result.run.scriptOutput ? 'automation script context' : undefined,
          outputPath: result.run.outputPath,
          success: true,
          summary: result.run.scriptOutput.slice(0, 220),
        });
        await appendRunEvidence(deps.projectDir, card);
        evidence.push(card);
      }
      if (results.length > 0) {
        deps.notifyAutomationCompleted(results.map((r) => ({ jobId: r.jobId, name: r.name })));
      }
      res.json({
        executed: results.length,
        results: results.map((r) => ({ jobId: r.jobId, name: r.name, scriptOutput: r.run.scriptOutput, outputPath: r.run.outputPath })),
        evidence,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/automations/:id/execute', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      if (deps.isKillSwitchActive()) { res.status(403).json({ error: 'Kill switch is active.' }); return; }
      const jobId = safeLocalId(req.params.id);
      if (!jobId) { res.status(400).json({ error: 'Invalid job id.' }); return; }
      const jobs = await listAutomationJobs(deps.projectDir);
      const job = jobs.find((j) => j.id === jobId);
      if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
      const policy = deps.getPolicyContext();
      const run = await prepareAutomationRun(deps.projectDir, job, new Date(), policy);
      const card = deps.buildEvidenceCard({
        id: `automation:${jobId}:${new Date().toISOString()}`,
        kind: 'automation',
        request: run.prompt,
        runName: job.name,
        command: run.scriptOutput ? 'automation script context' : undefined,
        outputPath: run.outputPath,
        success: true,
        summary: (run.scriptOutput || '').slice(0, 220),
      });
      await appendRunEvidence(deps.projectDir, card);
      res.json({ ok: true, jobId, name: job.name, scriptOutput: run.scriptOutput, outputPath: run.outputPath, evidence: card });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Preview an automation schedule string without persisting anything. Used by
  // the wizard's "Next run" hint so users see what they're about to commit.
  router.post('/api/automations/preview', (req, res) => {
    const value = typeof req.body?.schedule === 'string' ? req.body.schedule : '';
    if (!value.trim()) { res.status(400).json({ error: 'schedule is required.' }); return; }
    try {
      const now = new Date();
      const schedule = parseAutomationSchedule(value, now);
      const nextRunAt = computeNextAutomationRun(schedule, undefined, now);
      res.json({ ok: true, schedule, nextRunAt });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/automations/jobs/safety', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const jobs = await listAutomationJobs(deps.projectDir);
      res.json({ audit: auditAutomationJobSafety(jobs) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/automations/orphaned', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
      const orphaned = await listOrphanedRuns(deps.projectDir, { limit });
      res.json({ orphaned });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/automations/jobs', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const name = String(req.body?.name ?? '').trim();
      const prompt = String(req.body?.prompt ?? '').trim();
      const schedule = String(req.body?.schedule ?? '').trim();
      if (!name || !prompt || !schedule) {
        res.status(400).json({ error: 'name, prompt, and schedule are required.' });
        return;
      }
      const scriptCommand = typeof req.body?.scriptCommand === 'string' ? req.body.scriptCommand : undefined;
      const job = await createAutomationJob(deps.projectDir, { name, prompt, schedule, scriptCommand });
      logger.info('Automation', 'Job created', { jobId: job.id, name: job.name });
      res.json({ job });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/automations/jobs/:id', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const jobId = String(req.params.id ?? '').trim();
      const deleted = await deleteAutomationJob(deps.projectDir, jobId);
      if (!deleted) { res.status(404).json({ error: 'Automation job not found.' }); return; }
      logger.info('Automation', 'Job deleted', { jobId });
      res.json({ deleted: jobId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/api/automations/jobs/:id', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const jobId = String(req.params.id ?? '').trim();
      const updated = await updateAutomationJob(deps.projectDir, jobId, req.body ?? {});
      if (!updated) { res.status(404).json({ error: 'Automation job not found.' }); return; }
      logger.info('Automation', 'Job updated', { jobId, name: updated.name });
      res.json({ job: updated });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/automations/runs', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const entries = await readAutomationRunLog(deps.projectDir);
      const evidence = await readRunEvidence(deps.projectDir);
      res.json({ runs: entries, evidence: evidence.filter((card) => card.kind === 'automation') });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/automations/output', async (req, res) => {
    try {
      const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!rawPath) { res.status(400).json({ error: 'path is required' }); return; }
      const resolved = path.resolve(deps.projectDir, rawPath);
      const automationsDir = path.resolve(deps.projectDir, '.harness', 'automations');
      if (!resolved.startsWith(automationsDir)) { res.status(403).json({ error: 'Path must be inside .harness/automations/' }); return; }
      const content = await fs.readFile(resolved, 'utf-8');
      res.json({ path: rawPath, content: content.slice(0, 50_000) });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
