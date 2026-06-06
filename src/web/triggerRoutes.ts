import express from 'express';
import { loadTriggers, saveTriggers, type TriggerDefinition } from '../services/triggerScheduler';
import { recordSwallowed } from '../observability/silentFailureSink';

export interface TriggerRoutesDeps {
  projectDir: string;
  isEnabled: () => boolean;
  invalidateScheduler: () => Promise<void> | void;
}

function sanitizeTriggerInput(value: unknown): TriggerDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim()) return null;
  if (typeof v.command !== 'string' || !v.command.trim()) return null;
  const intervalSeconds = Number(v.intervalSeconds);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) return null;
  const args = Array.isArray(v.args) ? v.args.filter((arg): arg is string => typeof arg === 'string') : undefined;
  const cwd = typeof v.cwd === 'string' && v.cwd.trim() ? v.cwd : undefined;
  const enabled = v.enabled === undefined ? true : Boolean(v.enabled);
  return { id: v.id.trim(), command: v.command.trim(), args, cwd, intervalSeconds: Math.floor(intervalSeconds), enabled };
}

export function createTriggerRouter(deps: TriggerRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, isEnabled, invalidateScheduler } = deps;

  const invalidate = async () => {
    try {
      await invalidateScheduler();
    } catch (err) {
      recordSwallowed('triggerScheduler.invalidate', err);
    }
  };

  router.get('/api/triggers', async (_req, res) => {
    try {
      const triggers = await loadTriggers(projectDir);
      res.json({ enabled: isEnabled(), triggers });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/triggers', async (req, res) => {
    try {
      const definition = sanitizeTriggerInput(req.body);
      if (!definition) { res.status(400).json({ error: 'id, command, intervalSeconds are required.' }); return; }
      const triggers = await loadTriggers(projectDir);
      if (triggers.some((trigger) => trigger.id === definition.id)) {
        res.status(409).json({ error: `Trigger ${definition.id} already exists.` }); return;
      }
      triggers.push(definition);
      await saveTriggers(projectDir, triggers);
      await invalidate();
      res.json({ trigger: definition });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/api/triggers/:id', async (req, res) => {
    try {
      const triggers = await loadTriggers(projectDir);
      const idx = triggers.findIndex((trigger) => trigger.id === req.params.id);
      if (idx === -1) { res.status(404).json({ error: 'Trigger not found.' }); return; }
      const updates = req.body ?? {};
      const merged: TriggerDefinition = {
        ...triggers[idx],
        ...(typeof updates.command === 'string' ? { command: updates.command.trim() } : {}),
        ...(Array.isArray(updates.args) ? { args: updates.args.filter((arg: unknown): arg is string => typeof arg === 'string') } : {}),
        ...(typeof updates.cwd === 'string' ? { cwd: updates.cwd } : {}),
        ...(updates.intervalSeconds !== undefined ? { intervalSeconds: Math.max(1, Math.floor(Number(updates.intervalSeconds))) } : {}),
        ...(updates.enabled !== undefined ? { enabled: Boolean(updates.enabled) } : {}),
      };
      triggers[idx] = merged;
      await saveTriggers(projectDir, triggers);
      await invalidate();
      res.json({ trigger: merged });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/triggers/:id', async (req, res) => {
    try {
      const triggers = await loadTriggers(projectDir);
      const idx = triggers.findIndex((trigger) => trigger.id === req.params.id);
      if (idx === -1) { res.status(404).json({ error: 'Trigger not found.' }); return; }
      triggers.splice(idx, 1);
      await saveTriggers(projectDir, triggers);
      await invalidate();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
