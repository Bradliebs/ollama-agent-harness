// Express router for confidence calibration + golden traces.
//
// Extracted from server.ts as slice 5 of audit Fix #7. These two surfaces
// share an extraction because they're both eval-related, both projectDir-
// only, and they appear back-to-back in server.ts. server.ts keeps
// `renderDriftReport` because it's still used outside the HTTP layer.

import express from 'express';
import {
  recordSample as recordCalibrationSample,
  generateReport as generateCalibrationReport,
  generateAllReports as generateAllCalibrationReports,
} from '../eval/confidenceCalibration';
import {
  saveGoldenTrace,
  loadGoldenTrace,
  listGoldenTraces,
  deleteGoldenTrace,
  compareWithGolden,
  captureFromRun,
} from '../eval/goldenTraces';

export interface EvalRoutesDeps {
  projectDir: string;
}

export function createEvalRouter(deps: EvalRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  // ─── Confidence Calibration ──────────────────────────────────────────

  router.post('/api/calibration/sample', async (req, res) => {
    try {
      const sample = req.body;
      if (!sample?.id || !sample?.model || typeof sample?.predictedConfidence !== 'number') {
        res.status(400).json({ error: 'id, model, and predictedConfidence are required.' });
        return;
      }
      await recordCalibrationSample(projectDir, sample);
      res.json({ recorded: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/calibration/report/:model', async (req, res) => {
    try {
      const report = await generateCalibrationReport(projectDir, req.params.model);
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/calibration/reports', async (_req, res) => {
    try {
      const reports = await generateAllCalibrationReports(projectDir);
      res.json({ reports });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ─── Golden Traces ──────────────────────────────────────────────────

  router.get('/api/golden-traces', async (_req, res) => {
    try {
      const traces = await listGoldenTraces(projectDir);
      res.json({ traces });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/golden-traces/:id', async (req, res) => {
    try {
      const trace = await loadGoldenTrace(projectDir, req.params.id);
      if (!trace) { res.status(404).json({ error: 'Trace not found.' }); return; }
      res.json(trace);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/golden-traces', async (req, res) => {
    try {
      const trace = req.body;
      if (!trace?.id || !trace?.name || !trace?.input) {
        res.status(400).json({ error: 'id, name, and input are required.' });
        return;
      }
      await saveGoldenTrace(projectDir, trace);
      res.json({ saved: trace.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/golden-traces/capture', (req, res) => {
    try {
      const { name, model, input, output, toolCalls, files, tags, notes } = req.body ?? {};
      if (!name || !model || !input) {
        res.status(400).json({ error: 'name, model, and input are required.' });
        return;
      }
      const trace = captureFromRun(name, model, input, output ?? '', toolCalls ?? [], files ?? [], { tags, notes });
      res.json(trace);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/golden-traces/:id/compare', async (req, res) => {
    try {
      const trace = await loadGoldenTrace(projectDir, req.params.id);
      if (!trace) { res.status(404).json({ error: 'Trace not found.' }); return; }
      const { output, toolCalls, files } = req.body ?? {};
      const result = compareWithGolden(trace, {
        output: output ?? '',
        toolCalls: toolCalls ?? [],
        files: files ?? [],
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/golden-traces/:id', async (req, res) => {
    try {
      const deleted = await deleteGoldenTrace(projectDir, req.params.id);
      if (!deleted) { res.status(404).json({ error: 'Trace not found.' }); return; }
      res.json({ deleted: req.params.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
