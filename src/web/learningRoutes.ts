import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';

import { ModelRoutingPolicy, calibrateModelRoutingPolicy, summarizeRoutingMetrics } from '../agents/modelRouting';
import { listSubagentRoutingMetrics } from '../agents/subagent';
import {
  createOutputValidationTrendExport,
  listEvalTraceExamples,
  listEvalTraceRuns,
  summarizeContextLossRuns,
  summarizeEvalTraceRuns,
  summarizeOutputValidationRuns,
  summarizeProfileFeedbackRuns,
} from '../learning/evalTrace';
import {
  evaluatePromotionGateForCandidate,
  getLearningCandidateProvenance,
  listReviewedLearningCandidates,
  reviewLearningCandidate,
} from '../learning/sessionLearning';

export interface LearningRoutesDeps {
  projectDir: string;
  getModelRouting: () => ModelRoutingPolicy;
  applyRoutingCalibration: (suggestedPolicy: Partial<ModelRoutingPolicy>) => Promise<unknown>;
}

function safeCandidateId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && /^[a-zA-Z0-9:._-]+$/.test(id) ? id : null;
}

export function createLearningRouter(deps: LearningRoutesDeps): express.Router {
  const { projectDir, getModelRouting, applyRoutingCalibration } = deps;
  const router = express.Router();

  router.get('/api/learning', async (_req, res) => {
    const learningDir = path.join(projectDir, '.harness', 'learning');
    const result: Record<string, unknown> = {};
    try {
      result.patterns = JSON.parse(await fs.readFile(path.join(learningDir, 'detected-patterns.json'), 'utf-8'));
    } catch { result.patterns = []; }
    try {
      const raw = await fs.readFile(path.join(learningDir, 'reflections.jsonl'), 'utf-8');
      result.reflections = raw.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-20);
    } catch { result.reflections = []; }
    try {
      result.evolvedPrompt = await fs.readFile(path.join(learningDir, 'evolved-prompt.md'), 'utf-8');
    } catch { result.evolvedPrompt = ''; }
    try {
      result.digest = await fs.readFile(path.join(learningDir, 'consolidated-digest.md'), 'utf-8');
    } catch { result.digest = ''; }
    const subagentRouting = await listSubagentRoutingMetrics(projectDir, 100);
    result.candidates = await listReviewedLearningCandidates(projectDir);
    result.subagentRouting = subagentRouting;
    result.routingSummary = summarizeRoutingMetrics(subagentRouting);
    result.routingCalibration = calibrateModelRoutingPolicy(subagentRouting, getModelRouting());
    const evalRuns = await listEvalTraceRuns(projectDir);
    result.evalExamples = await listEvalTraceExamples(projectDir);
    result.evalRuns = evalRuns;
    result.evalRunTrend = summarizeEvalTraceRuns(evalRuns);
    result.outputValidationTrend = summarizeOutputValidationRuns(evalRuns);
    result.profileFeedbackTrend = summarizeProfileFeedbackRuns(evalRuns);
    result.contextLossTrend = summarizeContextLossRuns(evalRuns);
    try {
      const raw = await fs.readFile(path.join(learningDir, 'tool-usage.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      result.totalToolCalls = lines.length;
      const counts: Record<string, number> = {};
      for (const line of lines) { try { const e = JSON.parse(line); counts[e.tool] = (counts[e.tool] || 0) + 1; } catch {} }
      result.toolBreakdown = counts;
    } catch { result.totalToolCalls = 0; result.toolBreakdown = {}; }
    res.json(result);
  });

  router.get('/api/learning/routing', async (_req, res) => {
    try {
      const metrics = await listSubagentRoutingMetrics(projectDir, 100);
      res.json({ metrics, summary: summarizeRoutingMetrics(metrics), calibration: calibrateModelRoutingPolicy(metrics, getModelRouting()) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/learning/output-validation-trends/download', async (_req, res) => {
    try {
      const runs = await listEvalTraceRuns(projectDir, 1000);
      const payload = createOutputValidationTrendExport(runs);
      const stamp = payload.generatedAt.replace(/[:.]/g, '-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="output-validation-trends-${stamp}.json"`);
      res.send(JSON.stringify(payload, null, 2));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/learning/routing/apply-calibration', async (_req, res) => {
    try {
      const metrics = await listSubagentRoutingMetrics(projectDir, 100);
      const calibration = calibrateModelRoutingPolicy(metrics, getModelRouting());
      const settings = await applyRoutingCalibration(calibration.suggestedPolicy);
      res.json({ settings, calibration });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/learning/candidates/review', async (req, res) => {
    const candidateId = String(req.body?.id ?? '').trim();
    const action = req.body?.action === 'promote' || req.body?.action === 'reject' ? req.body.action : null;
    if (!candidateId || !action) { res.status(400).json({ error: 'Candidate id and review action are required.' }); return; }
    try {
      const review = await reviewLearningCandidate(projectDir, candidateId, action, req.body?.reason?.toString());
      const candidates = await listReviewedLearningCandidates(projectDir);
      res.json({ review, candidates });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  router.get('/api/learning/candidates/:id/provenance', async (req, res) => {
    const candidateId = safeCandidateId(req.params.id);
    if (!candidateId) { res.status(400).json({ error: 'Invalid learning candidate id.' }); return; }
    try {
      res.json(await getLearningCandidateProvenance(projectDir, candidateId));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: msg });
    }
  });

  router.get('/api/learning/candidates/:id/gate', async (req, res) => {
    const candidateId = safeCandidateId(req.params.id);
    if (!candidateId) { res.status(400).json({ error: 'Invalid learning candidate id.' }); return; }
    try {
      const verdict = await evaluatePromotionGateForCandidate(projectDir, candidateId);
      if (!verdict.candidateFound) { res.status(404).json({ error: verdict.reason }); return; }
      res.json({
        gate_enabled: process.env.HARNESS_PROMOTION_GATE_ENABLED === '1',
        candidate_id: verdict.candidateId,
        allowed: verdict.allowed,
        reason: verdict.reason,
        pass_count: verdict.passCount,
        considered_runs: verdict.consideredRuns,
        required_passes: verdict.requiredPasses,
        pass_at_all: verdict.passAtAll,
        safety_violations: verdict.safetyViolations,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
