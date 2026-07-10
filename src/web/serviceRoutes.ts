import express from 'express';
import { exportAgenticServices, getAgenticService, importAgenticServices, listAgenticServices } from '../services/agenticServiceMode';
import { getServiceLifecycle, initServiceLifecycle, transitionService, probeServiceHealth, SERVICE_TEMPLATES, type ServiceLifecycleStatus } from '../services/serviceLifecycle';
import { emitEvent } from '../persistence/eventStore';
import { recordSwallowed } from '../observability/silentFailureSink';
import { logger } from '../core/logger';

export interface ServiceRoutesDeps {
  projectDir: string;
  /** Returns the lifecycle audit blob server.ts also exposes in /api/system/health. */
  getOperatingServiceLifecycleAudit: () => Record<string, unknown>;
  /** Records a run-evidence card for service export/import. Needs server.ts's
   *  current model + permission mode + capability-grant count, so it stays
   *  in server.ts and is passed in as a callable. */
  recordOperatingServiceEvidence: (action: 'export' | 'import', serviceIds: string[], summary: string) => Promise<void>;
}

const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
function safeLocalId(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || !SAFE_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function parseNonNegativeInteger(value: unknown, fallback: number, max = 100): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function summarizeServiceState(state: unknown): Record<string, number | boolean | string> {
  const source = typeof state === 'object' && state !== null ? state as Record<string, unknown> : {};
  const count = (key: string): number => Array.isArray(source[key]) ? (source[key] as unknown[]).length : 0;
  return {
    tasks: count('tasks'),
    notes: count('notes'),
    observations: count('observations'),
    reminders: count('reminders'),
    reviews: count('reviews'),
    enabled: source.enabled !== false,
    reminders_paused: source.reminders_paused === true,
    updated_at: typeof source.updated_at === 'string' ? source.updated_at : '',
  };
}

export function createServiceRouter(deps: ServiceRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/services', async (req, res) => {
    try {
      const limit = parseNonNegativeInteger(req.query.limit, 50, 200);
      const offset = parseNonNegativeInteger(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
      const services = await listAgenticServices(projectDir);
      const page = services.slice(offset, offset + limit);
      res.json({ total: services.length, limit, offset, lifecycle: deps.getOperatingServiceLifecycleAudit(), services: page.map((item) => ({ service: item.service, stateSummary: summarizeServiceState(item.state) })) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/services/export', async (req, res) => {
    try {
      const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
      const payload = await exportAgenticServices(projectDir, ids);
      await deps.recordOperatingServiceEvidence('export', payload.services.map((item) => item.service.service_id), `Exported ${payload.services.length} operating service(s).`).catch((error) => logger.warn('Services', 'Failed to record service export evidence', { error: error instanceof Error ? error.message : String(error) }));
      res.setHeader('Content-Disposition', `attachment; filename="operating-services-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(payload);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/services/import', async (req, res) => {
    try {
      const overwrite = req.query.overwrite === 'true' || req.body?.overwrite === true;
      const payload = req.body?.payload ?? req.body;
      const result = await importAgenticServices(projectDir, payload, { overwrite });
      await deps.recordOperatingServiceEvidence('import', [...result.imported, ...result.skipped], `Imported ${result.imported.length} and skipped ${result.skipped.length} operating service(s).`).catch((error) => logger.warn('Services', 'Failed to record service import evidence', { error: error instanceof Error ? error.message : String(error) }));
      res.json({ ok: true, ...result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // Templates route must precede :id so 'templates' isn't treated as an id.
  router.get('/api/services/templates', async (_req, res) => {
    res.json(SERVICE_TEMPLATES);
  });

  router.get('/api/services/:id', async (req, res) => {
    try {
      const serviceId = safeLocalId(req.params.id);
      if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
      const service = await getAgenticService(projectDir, serviceId);
      if (!service) { res.status(404).json({ error: 'Service not found.' }); return; }
      res.json(service);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/services/:id/lifecycle', async (req, res) => {
    try {
      const serviceId = safeLocalId(req.params.id);
      if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
      const lifecycle = await getServiceLifecycle(projectDir, serviceId);
      if (!lifecycle) { res.status(404).json({ error: 'No lifecycle found. Use POST to initialize.' }); return; }
      res.json(lifecycle);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/services/:id/lifecycle', async (req, res) => {
    try {
      const serviceId = safeLocalId(req.params.id);
      if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
      const targetStatus = req.body?.status as ServiceLifecycleStatus | undefined;
      if (!targetStatus) { res.status(400).json({ error: 'status is required.' }); return; }
      const existing = await getServiceLifecycle(projectDir, serviceId);
      if (!existing) {
        const state = await initServiceLifecycle(projectDir, serviceId, targetStatus);
        await emitEvent(projectDir, 'service', 'lifecycle_initialized', { service_id: serviceId, status: targetStatus }, 'user', serviceId).catch((err) => recordSwallowed('emitEvent', err));
        res.json({ success: true, state });
        return;
      }
      const result = await transitionService(projectDir, serviceId, targetStatus, req.body?.error_message);
      if (result.success) {
        await emitEvent(projectDir, 'service', 'lifecycle_transitioned', { service_id: serviceId, from: result.from, to: result.to }, 'user', serviceId).catch((err) => recordSwallowed('emitEvent', err));
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/services/:id/health', async (req, res) => {
    try {
      const serviceId = safeLocalId(req.params.id);
      if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
      const health = await probeServiceHealth(projectDir, serviceId);
      res.json(health);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
