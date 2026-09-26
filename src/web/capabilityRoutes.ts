import express from 'express';
import * as crypto from 'crypto';
import { createAutomationJob } from '../automation/jobs';
import { listShellCommandAllowlistPresets } from '../automation/runner';
import { OPENAI_COMPATIBLE_PRESETS, readApiKey } from '../core/chatClientFactory';
import {
  createCapabilityGrant,
  findExpiredGrants,
  listActiveCapabilityGrants,
  listCapabilityPolicies,
  mapToolsToCapabilityCoverage,
  pruneStaleCapabilityGrants,
  revokeCapabilityGrant,
  sanitizeCapabilityGrants,
  summarizeCapabilityAlignment,
  type CapabilityGrant,
} from '../permissions/capabilities';
import { appendCapabilityAuditEvent, readCapabilityAuditEvents } from '../permissions/capabilityAudit';
import { applyGrantToLadder, loadTrustLadder, saveTrustLadder } from '../jarvis';
import { createDefaultCapabilityRegistry } from '../services/capabilityRegistry';
import { evaluateCapabilityTemplates, type ConnectorReadinessInput } from '../services/capabilityTemplates';
import {
  getCapabilityTemplateStarter,
  listCapabilityTemplateStarters,
  type CapabilityTemplateStarter,
} from '../services/capabilityTemplateStarters';
import * as ragIndex from '../persistence/ragIndex';

export interface CapabilityTemplateReadiness {
  telegramReady: boolean;
  discordReady: boolean;
  slackStatus: { configured?: boolean; mode?: string };
  whatsAppStatus: { configured?: boolean; hasAllowedRecipients?: boolean; mode?: string };
  connectors: Record<string, ConnectorReadinessInput>;
}

export interface CapabilityRegistrySnapshot {
  capabilities: unknown[];
  available: string[];
  missing: Array<{ id: string; reason?: string }>;
}

export interface CapabilityRoutesDeps {
  projectDir: string;
  ensureSettingsLoaded: () => Promise<void>;
  requireAuth: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
  requireAuditReason: (value: unknown, res: express.Response, actionLabel: string) => string | null;
  saveSettingsToDisk: () => Promise<void>;
  getCapabilityGrants: () => CapabilityGrant[];
  setCapabilityGrants: (grants: CapabilityGrant[]) => void;
  getTemplateReadiness: () => CapabilityTemplateReadiness;
  getCapabilityRegistrySnapshot: () => CapabilityRegistrySnapshot;
  createGeneratedDocument: (input: {
    title: string;
    template: unknown;
    format: unknown;
    sourceLabel: string;
    content: string;
  }) => Promise<{ metadata: unknown; content: string }>;
  normalizeDocumentTemplate: (value: unknown) => unknown;
  normalizeDocumentFormat: (value: unknown) => unknown;
  logger: { info: (component: string, message: string, meta?: Record<string, unknown>) => void };
}

function starterActionPreview(starter: CapabilityTemplateStarter): Record<string, unknown> {
  if (starter.kind === 'document') return { kind: starter.kind, document: starter.document, writes: ['.harness/documents'] };
  if (starter.kind === 'automation') return { kind: starter.kind, automationJob: starter.automationJob, writes: ['.harness/automations/jobs.json'] };
  return { kind: starter.kind };
}

export function createCapabilityRouter(deps: CapabilityRoutesDeps): express.Router {
  const router = express.Router();

  router.get('/api/capability-templates', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const registry = createDefaultCapabilityRegistry();
      const readiness = deps.getTemplateReadiness();
      const ragIndexes = await ragIndex.listIndexes(deps.projectDir).catch(() => []);
      const anyNotificationReady = readiness.telegramReady || readiness.discordReady || Boolean(readiness.slackStatus.configured) || Boolean(readiness.whatsAppStatus.configured && readiness.whatsAppStatus.hasAllowedRecipients);
      const cloudConfigured = Object.values(OPENAI_COMPATIBLE_PRESETS).some((preset) => Boolean(readApiKey(preset)));
      if (anyNotificationReady) registry.register('notifications', 'Push notifications', 'available');
      if (readiness.telegramReady) registry.register('telegram', 'Telegram messaging', 'available');
      if (ragIndexes.length > 0) registry.register('vector_memory', 'Vector/semantic memory', 'available');
      if (cloudConfigured) registry.register('cloud_models', 'Cloud LLM backends', 'available');
      if (process.env.HARNESS_SMTP_HOST && process.env.HARNESS_SMTP_USER && process.env.HARNESS_SMTP_PASS) registry.register('email', 'Email sending', 'available');

      const starters = listCapabilityTemplateStarters();
      const templates = evaluateCapabilityTemplates(registry, readiness.connectors).map((template) => ({
        ...template,
        starterKinds: starters.filter((starter) => starter.templateId === template.id).map((starter) => starter.kind),
        hasStarter: starters.some((starter) => starter.templateId === template.id),
      }));
      res.json({ generatedAt: new Date().toISOString(), templates });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/capability-templates/starters', (_req, res) => {
    try {
      res.json({ starters: listCapabilityTemplateStarters() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/capability-templates/:id/starter', (req, res) => {
    try {
      const templateId = String(req.params.id ?? '').trim();
      const starter = getCapabilityTemplateStarter(templateId);
      if (!starter) {
        res.status(404).json({ error: 'Capability template starter not found.' });
        return;
      }
      res.json({ starter });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/capability-templates/:id/actions', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const templateId = String(req.params.id ?? '').trim();
      const starter = getCapabilityTemplateStarter(templateId);
      if (!starter) {
        res.status(404).json({ error: 'Capability template starter not found.' });
        return;
      }
      const action = req.body?.action === 'create' ? 'create' : 'preview';
      if (action === 'preview') {
        res.json({ ok: true, action, starter, preview: starterActionPreview(starter) });
        return;
      }
      if (starter.kind === 'document') {
        if (!starter.document) { res.status(400).json({ error: 'Starter has no document payload.' }); return; }
        const document = await deps.createGeneratedDocument({
          title: starter.title,
          template: deps.normalizeDocumentTemplate(starter.document.template),
          format: deps.normalizeDocumentFormat(starter.document.format),
          sourceLabel: starter.document.sourceLabel,
          content: starter.document.content,
        });
        res.json({ ok: true, action, kind: starter.kind, starter, document: document.metadata, content: document.content });
        return;
      }
      if (starter.kind === 'automation') {
        if (!starter.automationJob) { res.status(400).json({ error: 'Starter has no automation payload.' }); return; }
        const job = await createAutomationJob(deps.projectDir, {
          name: starter.automationJob.name,
          prompt: starter.automationJob.prompt,
          schedule: starter.automationJob.schedule,
          scriptCommand: starter.automationJob.scriptCommand,
        });
        deps.logger.info('CapabilityTemplates', 'Starter automation job created', { templateId, jobId: job.id, name: job.name });
        res.json({ ok: true, action, kind: starter.kind, starter, job });
        return;
      }
      res.status(400).json({ error: `Unsupported starter kind: ${starter.kind}` });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/capabilities/registry', async (_req, res) => {
    await deps.ensureSettingsLoaded();
    res.json(deps.getCapabilityRegistrySnapshot());
  });

  router.get('/api/capabilities', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const capabilities = listCapabilityPolicies();
      const activeGrants = listActiveCapabilityGrants(deps.getCapabilityGrants());
      const expired = findExpiredGrants(deps.getCapabilityGrants());
      if (expired.length > 0) {
        let grants = deps.getCapabilityGrants();
        for (const grant of expired) {
          await appendCapabilityAuditEvent(deps.projectDir, { type: 'grant.expired', capabilityId: grant.capabilityId, grantId: grant.id });
          grants = revokeCapabilityGrant(grants, grant.id);
        }
        deps.setCapabilityGrants(grants);
        await deps.saveSettingsToDisk();
      }
      res.json({
        capabilities,
        summary: summarizeCapabilityAlignment(capabilities),
        coverage: mapToolsToCapabilityCoverage(),
        grants: activeGrants,
        grantCount: activeGrants.length,
        shellCommandPresets: listShellCommandAllowlistPresets(),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/capabilities/grants', async (req, res) => {
    try {
      if (!deps.requireAuth(req, res, 'capability grant creation')) return;
      await deps.ensureSettingsLoaded();
      const capabilityId = String(req.body?.capabilityId ?? '').trim();
      const reason = deps.requireAuditReason(req.body?.reason, res, 'Capability grant creation');
      if (!reason) return;
      const controls = Array.isArray(req.body?.controls) ? req.body.controls : [];
      const result = createCapabilityGrant({
        id: crypto.randomUUID(),
        capabilityId,
        controls,
        reason,
        expiresInMinutes: req.body?.expiresInMinutes,
        commandAllowlist: Array.isArray(req.body?.commandAllowlist) ? req.body.commandAllowlist : undefined,
      });
      if (!result.grant) {
        const status = result.evaluation.decision === 'deny' ? 403 : 400;
        res.status(status).json({ error: result.evaluation.reason, evaluation: result.evaluation });
        return;
      }
      const grants = pruneStaleCapabilityGrants(sanitizeCapabilityGrants([...deps.getCapabilityGrants(), result.grant]));
      deps.setCapabilityGrants(grants);
      await deps.saveSettingsToDisk();
      await appendCapabilityAuditEvent(deps.projectDir, { type: 'grant.created', capabilityId, grantId: result.grant.id, reason: result.grant.reason });
      deps.logger.info('Capabilities', 'Capability grant created', { capabilityId, grantId: result.grant.id, expiresAt: result.grant.expiresAt });
      // Jarvis: bridge grant create → trust ladder acceptance.
      try {
        const snap = await loadTrustLadder(deps.projectDir);
        applyGrantToLadder(snap, capabilityId, 'create');
        await saveTrustLadder(deps.projectDir, snap);
      } catch { /* best-effort */ }
      res.json({ grant: result.grant, evaluation: result.evaluation, grants: listActiveCapabilityGrants(deps.getCapabilityGrants()) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/api/capabilities/grants/:id', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const grantId = String(req.params.id ?? '').trim();
      const before = deps.getCapabilityGrants().find((grant) => grant.id === grantId);
      if (!before) { res.status(404).json({ error: 'Capability grant not found.' }); return; }
      deps.setCapabilityGrants(revokeCapabilityGrant(deps.getCapabilityGrants(), grantId));
      await deps.saveSettingsToDisk();
      await appendCapabilityAuditEvent(deps.projectDir, { type: 'grant.revoked', capabilityId: before.capabilityId, grantId });
      deps.logger.info('Capabilities', 'Capability grant revoked', { capabilityId: before.capabilityId, grantId });
      // Jarvis: bridge grant revoke → trust ladder rejection.
      try {
        const snap = await loadTrustLadder(deps.projectDir);
        applyGrantToLadder(snap, before.capabilityId, 'revoke');
        await saveTrustLadder(deps.projectDir, snap);
      } catch { /* best-effort */ }
      res.json({ revoked: grantId, grants: listActiveCapabilityGrants(deps.getCapabilityGrants()) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/capabilities/audit', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const events = await readCapabilityAuditEvents(deps.projectDir);
      res.json({ events: events.slice(-200).reverse() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
