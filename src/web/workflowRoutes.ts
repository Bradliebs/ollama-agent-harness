import * as path from 'path';
import { promises as fs } from 'fs';
import express from 'express';

import type { Tool } from '../types';
import type { PermissionEngine } from '../permissions/engine';
import type { WorkflowRegistry } from '../workflows/workflowRegistry';
import { createToolRegistry } from '../tools/registry';
import { recordSwallowed } from '../observability/silentFailureSink';
import { logger } from '../core/logger';

export interface WorkflowRunContext {
  tools: Tool[];
  permissions: PermissionEngine;
}

export interface WorkflowRoutesDeps {
  projectDir: string;
  workflowsDir: string;
  workflowRegistry: WorkflowRegistry;
  buildRunContext: () => WorkflowRunContext;
}

export function createWorkflowRouter(deps: WorkflowRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, workflowsDir, workflowRegistry, buildRunContext } = deps;

  // Read the workflow file index. Workflows live under .harness/workflows/<name>.
  router.get('/api/workflows', async (_req, res) => {
    try {
      const workflows = await workflowRegistry.list();
      res.json({ workflows: workflows.map((wf) => ({ ...wf, stepCount: wf.steps.length })) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // List + run accessors share /api/workflows/runs* and need to win over the
  // /:name catch-all. Declare them before the param routes.
  router.get('/api/workflows/runs', (_req, res) => {
    res.json({ runs: workflowRegistry.listRuns() });
  });

  router.get('/api/workflows/runs/:id', (req, res) => {
    try {
      const run = workflowRegistry.getRun(String(req.params.id || ''));
      if (!run) { res.status(404).json({ error: 'run not found' }); return; }
      res.json({ run });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/workflows/runs/:id/pause', (req, res) => {
    try {
      const ok = workflowRegistry.pause(String(req.params.id || ''), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
      if (!ok) { res.status(409).json({ error: 'run is not running' }); return; }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/workflows/runs/:id/resume', async (req, res) => {
    const id = String(req.params.id || '');
    const run = workflowRegistry.getRun(id);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    if (!workflowRegistry.resume(id)) { res.status(409).json({ error: 'run is not paused' }); return; }
    const ctx = buildRunContext();
    workflowRegistry.execute(id, ctx).catch((error) => {
      logger.warn('Workflow', 'Workflow run threw on resume', { runId: id, error: error instanceof Error ? error.message : String(error) });
    });
    res.json({ ok: true });
  });

  router.post('/api/workflows/runs/:id/cancel', (req, res) => {
    try {
      const ok = workflowRegistry.cancel(String(req.params.id || ''), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
      if (!ok) { res.status(409).json({ error: 'run cannot be cancelled' }); return; }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/workflows/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) { res.status(400).json({ error: 'workflow name required' }); return; }
    try {
      if (req.query.raw === '1') {
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeName || safeName !== name) { res.status(400).json({ error: 'invalid workflow name' }); return; }
        // Workflows can be .yaml, .yml, or .json — try in priority order.
        for (const ext of ['.yaml', '.yml', '.json']) {
          const filePath = path.join(workflowsDir, `${safeName}${ext}`);
          const content = await fs.readFile(filePath, 'utf-8').catch(() => null);
          if (content !== null) { res.json({ name: safeName, filePath, content }); return; }
        }
        res.status(404).json({ error: 'workflow file not found' });
        return;
      }
      const definition = await workflowRegistry.load(name);
      if (!definition) { res.status(404).json({ error: 'workflow not found' }); return; }
      res.json(definition);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Replace a workflow YAML/JSON file's content. Body: { content: string, ext?: '.yaml'|'.yml'|'.json' }
  router.put('/api/workflows/:name', async (req, res) => {
    const rawName = String(req.params.name || '').trim();
    const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name || name !== rawName) { res.status(400).json({ error: 'invalid workflow name' }); return; }
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) { res.status(400).json({ error: 'content is required' }); return; }
    if (content.length > 200_000) { res.status(413).json({ error: 'content too large (max 200KB)' }); return; }
    try {
      await fs.mkdir(workflowsDir, { recursive: true });
      // Find existing file by extension; default to .yaml when creating new.
      let target: string | null = null;
      for (const ext of ['.yaml', '.yml', '.json']) {
        const candidate = path.join(workflowsDir, `${name}${ext}`);
        if (await fs.stat(candidate).catch(() => null)) { target = candidate; break; }
      }
      if (!target) target = path.join(workflowsDir, `${name}.yaml`);
      // Validate by writing to a temp path under workflowsDir and asking the
      // registry to load it. If parsing or tool resolution fails, reject without
      // touching the original file. Only skipped when ?skipValidate=1.
      const skipValidate = req.query.skipValidate === '1';
      if (!skipValidate) {
        const tempName = `__tmp__${name}__${Date.now()}`;
        const tempExt = path.extname(target) || '.yaml';
        const tempPath = path.join(workflowsDir, `${tempName}${tempExt}`);
        try {
          await fs.writeFile(tempPath, content, 'utf-8');
          const definition = await workflowRegistry.load(tempName);
          if (!definition) { res.status(400).json({ error: 'Workflow content failed to parse.' }); return; }
          const knownTools = new Set(createToolRegistry(projectDir).listEntries().map((entry) => entry.tool.name));
          const unknown = definition.steps.map((s) => s.tool).filter((t) => t && !knownTools.has(t));
          if (unknown.length > 0) {
            res.status(400).json({ error: 'Unknown tool(s): ' + Array.from(new Set(unknown)).join(', ') });
            return;
          }
        } finally {
          await fs.unlink(tempPath).catch((err) => recordSwallowed('fs.unlink', err));
        }
      }
      await fs.writeFile(target, content, 'utf-8');
      res.json({ ok: true, name, filePath: target });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Create a new workflow YAML file from a structured payload. The wizard UI
  // posts here; YAML is hand-emitted so we don't need to add a YAML serializer
  // dependency. Body: { name, description?, steps: [{ id, tool, input?, description?, continueOnError? }] }
  router.post('/api/workflows', async (req, res) => {
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name || name !== rawName) {
      res.status(400).json({ error: 'name must contain only letters, numbers, dashes, and underscores.' });
      return;
    }
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    if (steps.length === 0) { res.status(400).json({ error: 'At least one step is required.' }); return; }
    // Validate every step's tool exists in the live registry so users see typos
    // at create time instead of run time.
    const knownTools = new Set(createToolRegistry(projectDir).listEntries().map((entry) => entry.tool.name));
    const unknownTools: string[] = [];
    for (const raw of steps) {
      const tool = String(raw?.tool || '').trim();
      if (tool && !knownTools.has(tool)) unknownTools.push(tool);
    }
    if (unknownTools.length > 0) {
      res.status(400).json({ error: 'Unknown tool(s): ' + Array.from(new Set(unknownTools)).join(', ') });
      return;
    }
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const filePath = path.join(workflowsDir, `${name}.yaml`);
    try {
      await fs.mkdir(workflowsDir, { recursive: true });
      const existing = await fs.stat(filePath).catch(() => null);
      if (existing && req.body?.overwrite !== true) {
        res.status(409).json({ error: 'Workflow already exists. Pass overwrite=true to replace it.' });
        return;
      }
      const lines: string[] = [`name: ${JSON.stringify(name)}`];
      if (description) lines.push(`description: ${JSON.stringify(description)}`);
      lines.push('steps:');
      for (const raw of steps) {
        const stepId = String(raw?.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
        const tool = String(raw?.tool || '').trim();
        if (!stepId || !tool) {
          res.status(400).json({ error: 'Each step needs a non-empty id and tool.' });
          return;
        }
        lines.push(`  - id: ${JSON.stringify(stepId)}`);
        lines.push(`    tool: ${JSON.stringify(tool)}`);
        if (raw?.description) lines.push(`    description: ${JSON.stringify(String(raw.description))}`);
        if (raw?.continueOnError === true) lines.push('    continueOnError: true');
        const input = raw?.input;
        if (input && typeof input === 'object') {
          lines.push('    input:');
          for (const [k, v] of Object.entries(input)) {
            lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
          }
        }
      }
      await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
      res.json({ ok: true, name, filePath });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Start a run. Optional body: { dryRun: boolean, variables: object }.
  router.post('/api/workflows/:name/run', async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) { res.status(400).json({ error: 'workflow name required' }); return; }
    try {
      const definition = await workflowRegistry.load(name);
      if (!definition) { res.status(404).json({ error: 'workflow not found' }); return; }
      const dryRun = Boolean(req.body?.dryRun);
      const variables = typeof req.body?.variables === 'object' && req.body.variables !== null ? req.body.variables : undefined;
      const run = workflowRegistry.startRun(definition, { dryRun, variables });
      const ctx = buildRunContext();
      // Execute asynchronously so the HTTP request returns immediately with the
      // initial run state. Errors are captured on the run object itself.
      workflowRegistry.execute(run.id, ctx).catch((error) => {
        logger.warn('Workflow', 'Workflow run threw', { runId: run.id, error: error instanceof Error ? error.message : String(error) });
      });
      res.json({ run });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
