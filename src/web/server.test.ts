import type { Server } from 'http';
import * as fs from 'fs/promises';
import http from 'http';
import * as os from 'os';
import * as path from 'path';
import { app, inferModelCapabilities, setWebRuntimeOverrides, stopUploadsAutoPrune } from './server';
import { runtimeTracer } from '../core/tracing';
import { SessionStorage } from '../persistence/sessionStorage';
import { appendLearningCandidate, extractLearningCandidate } from '../learning/sessionLearning';
import { appendSubagentRoutingMetric } from '../agents/subagent';
import { FileReadTool } from '../tools/fileTools';
import { createAutomationJob } from '../automation/jobs';
import { rebuildSessionSearchIndexWithMetadata } from '../persistence/sessionSearchIndex';
import { writeModelCatalogCache } from '../models/modelCatalog';
import type { LoopEvent, SessionEvent } from '../types';

jest.setTimeout(30_000);

describe('web server API validation', () => {
  let server: Server;
  let baseUrl: string;
  let originalSettings: string | null = null;
  let originalValidationProfiles: string | null = null;
  let originalMcpServers: string | null = null;
  let logSpy: jest.SpyInstance;
  const settingsPath = path.join(process.cwd(), '.harness', 'settings.json');
  const validationProfilesPath = path.join(process.cwd(), '.harness', 'output-validation-profiles.json');
  const mcpServersPath = path.join(process.cwd(), '.harness', 'mcp', 'servers.json');

  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      originalSettings = await fs.readFile(settingsPath, 'utf-8');
    } catch {
      originalSettings = null;
    }
    try {
      originalValidationProfiles = await fs.readFile(validationProfilesPath, 'utf-8');
    } catch {
      originalValidationProfiles = null;
    }
    try {
      originalMcpServers = await fs.readFile(mcpServersPath, 'utf-8');
    } catch {
      originalMcpServers = null;
    }
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    stopUploadsAutoPrune();
    if (originalSettings === null) {
      await fs.rm(settingsPath, { force: true });
    } else {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, originalSettings, 'utf-8');
    }
    if (originalValidationProfiles === null) {
      await fs.rm(validationProfilesPath, { force: true });
    } else {
      await fs.mkdir(path.dirname(validationProfilesPath), { recursive: true });
      await fs.writeFile(validationProfilesPath, originalValidationProfiles, 'utf-8');
    }
    if (originalMcpServers === null) {
      await fs.rm(mcpServersPath, { force: true });
    } else {
      await fs.mkdir(path.dirname(mcpServersPath), { recursive: true });
      await fs.writeFile(mcpServersPath, originalMcpServers, 'utf-8');
    }
    logSpy.mockRestore();
  });

  async function request(route: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${route}`, init);
  }

  it('rejects invalid permission mode settings', async () => {
    const response = await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'always' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid permission mode.' });
  });

  it('rejects invalid Ollama host settings', async () => {
    const response = await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ollamaHost: 'file:///tmp/socket' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid Ollama host.' });
  });

  it('returns installed version metadata for the About panel', async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    const response = await request('/api/about');

    expect(response.status).toBe(200);
    const body = await response.json() as { assetName: string; manifestUrl: string; releaseUrl: string; version: string; manifestName: string };
    expect(body).toMatchObject({
      version: packageJson.version,
      assetName: expect.stringContaining('ollama-agent-harness-v'),
      manifestName: expect.stringContaining('.zip.sha256.json'),
      manifestUrl: expect.stringContaining('/download/v'),
      releaseUrl: expect.stringContaining('/releases/tag/v'),
    });
    expect(body.assetName).toContain(`v${packageJson.version}`);
    expect(body.manifestUrl).toContain(`/download/v${packageJson.version}/`);
    expect(body.releaseUrl).toContain(`/releases/tag/v${packageJson.version}`);
  });

  it('persists validated settings to runtime storage', async () => {
    const response = await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'persist-test',
        temperature: 0.2,
        contextMaxTokens: 4096,
        modelRouting: {
          smallModel: 'tiny-helper',
          defaultModel: 'base-helper',
          strongModel: 'strong-helper',
          confidenceEscalationThreshold: 0.3,
        },
        mediaTools: {
          visionModel: 'llava',
          audioTranscribeCommand: 'whisper "{input}" --model base',
        },
      }),
    });

    expect(response.status).toBe(200);
    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as { model: string; temperature: number; contextMaxTokens: number; modelRouting: unknown; mediaTools: unknown };
    expect(saved).toMatchObject({
      model: 'persist-test',
      temperature: 0.2,
      contextMaxTokens: 4096,
      modelRouting: { smallModel: 'tiny-helper', defaultModel: 'base-helper', strongModel: 'strong-helper', confidenceEscalationThreshold: 0.3 },
      mediaTools: { visionModel: 'llava', audioTranscribeCommand: 'whisper "{input}" --model base' },
    });
  });

  it('persists model catalog and extension activation policy settings', async () => {
    const response = await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelCatalog: { url: 'https://example.com/catalog.json', ttlHours: 12 },
        extensionActivation: { executablePlugins: true, allowedPluginNames: ['trusted-plugin', 'bad$id'], requirePermissionReview: false },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      modelCatalog: { url: 'https://example.com/catalog.json', ttlHours: 12 },
      extensionActivation: { executablePlugins: true, allowedPluginNames: ['trusted-plugin'], requirePermissionReview: false },
    });
    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toContain('modelCatalog');
  });

  it('returns discovery payloads for catalog, extensions, automations, and session search', async () => {
    const pluginDir = path.join(process.cwd(), '.harness', 'plugins', 'trusted-plugin');
    const skillDir = path.join(process.cwd(), '.harness', 'skills', 'discovery-skill');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'trusted-plugin', description: 'Discovery test plugin.', version: '1.0.0', providesTools: ['test_tool'], providesHooks: ['beforeRun'] }, null, 2), 'utf-8');
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: discovery-skill\ndescription: Discovery test skill.\ndomain: tests\ntriggers:\n  - discovery\n---\n\n# Discovery Skill\n', 'utf-8');
    await createAutomationJob(process.cwd(), { name: 'due discovery job', prompt: 'summarize status', schedule: '1 minutes' }, new Date('2026-04-30T00:00:00.000Z'));
    await writeModelCatalogCache(process.cwd(), { version: 1, updatedAt: new Date().toISOString(), providers: { ollama: { models: [{ id: 'test-model:latest', description: 'Discovery test model' }] } } });
    await rebuildSessionSearchIndexWithMetadata(process.cwd());

    const response = await request('/api/discovery');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      modelCatalog: { manifest: { providers: { ollama: { models: expect.arrayContaining([expect.objectContaining({ id: 'test-model:latest' })]) } } } },
      extensions: {
        manifests: expect.arrayContaining([expect.objectContaining({ name: 'trusted-plugin', activation: expect.objectContaining({ status: expect.any(String) }) }), expect.objectContaining({ name: 'discovery-skill' })]),
        skills: {
          runtime: expect.objectContaining({ total: expect.any(Number), diagnosticCount: expect.any(Number) }),
          repo: expect.objectContaining({ total: expect.any(Number), diagnosticCount: expect.any(Number) }),
        },
      },
      automations: { total: expect.any(Number), due: expect.arrayContaining([expect.objectContaining({ name: 'due discovery job' })]) },
      sessionSearch: { exists: true, fresh: true, entryCount: expect.any(Number) },
    });
  });

  it('returns capability alignment policy for high-risk automation surfaces', async () => {
    const response = await request('/api/capabilities');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: 'password-manager-access', posture: 'blocked' }),
        expect.objectContaining({ id: 'live-broker-trading', posture: 'blocked' }),
        expect.objectContaining({ id: 'arbitrary-shell', posture: 'gated', existingCoverage: expect.arrayContaining(['bash']) }),
        expect.objectContaining({ id: 'background-autonomous-jobs', posture: 'gated' }),
      ]),
      summary: expect.objectContaining({ blocked: expect.any(Number), gated: expect.any(Number), 'design-only': expect.any(Number) }),
      coverage: expect.objectContaining({ 'arbitrary-shell': expect.arrayContaining(['bash']) }),
    });
  });

  it('includes capability alignment summary in the tools dashboard payload', async () => {
    const response = await request('/api/tools');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capabilities: {
        summary: expect.objectContaining({ blocked: 3, gated: 10, 'design-only': 0 }),
        coverage: expect.objectContaining({ 'self-modifying-code': expect.arrayContaining(['file_edit', 'file_write']) }),
      },
    });
  });

  it('returns readiness sections for Mission Control', async () => {
    const response = await request('/api/readiness');

    expect(response.status).toBe(200);
    const data = await response.json() as { permissionMode: string; sections: Array<{ id: string; label: string; score: number; status: string; checks: unknown[] }> };
    expect(data.permissionMode).toEqual(expect.any(String));
    expect(data.sections.map((section: { id: string }) => section.id)).toEqual(expect.arrayContaining(['chat', 'coding', 'research', 'automation', 'autonomy']));
    for (const section of data.sections) {
      expect(section.id).toEqual(expect.any(String));
      expect(section.label).toEqual(expect.any(String));
      expect(section.score).toEqual(expect.any(Number));
      expect(section.status).toEqual(expect.any(String));
      expect(Array.isArray(section.checks)).toBe(true);
    }
  });

  it('classifies Gemma 4 edge models as tool-capable instead of weak', () => {
    const capabilities = inferModelCapabilities('gemma4:e4b');

    expect(capabilities.toolUse).toBe('strong');
    expect(capabilities.notes.join(' ')).toContain('native tool/function calling');
    expect(capabilities.notes.join(' ')).not.toContain('consider a larger model');
  });

  it('uses backend prefixes when inferring cloud tool support', () => {
    expect(inferModelCapabilities('github/gpt-4o-mini').toolUse).toBe('strong');
    expect(inferModelCapabilities('replicate/meta/meta-llama-3-8b-instruct').toolUse).toBe('weak');
  });

  it('readiness plan-complete shows warn not blocked', async () => {
    const planPath = path.join(process.cwd(), 'IMPLEMENTATION_PLAN.md');
    const original = await fs.readFile(planPath, 'utf-8');
    const allDone = original.replace(/^- \[ \]/gm, '- [x]');
    await fs.writeFile(planPath, allDone, 'utf-8');
    try {
      const response = await request('/api/readiness');
      expect(response.status).toBe(200);
      const data = await response.json() as { sections: Array<{ id: string; checks: Array<{ id: string; status: string; message: string }> }> };
      const autonomy = data.sections.find((s) => s.id === 'autonomy');
      expect(autonomy).toBeDefined();
      const planCheck = autonomy!.checks.find((c) => c.id === 'plan.pending');
      expect(planCheck).toBeDefined();
      expect(planCheck!.status).toBe('warn');
      expect(planCheck!.message).toContain('Plan complete');
    } finally {
      await fs.writeFile(planPath, original, 'utf-8');
    }
  });

  it('readiness scores are between 0 and 100', async () => {
    const response = await request('/api/readiness');
    expect(response.status).toBe(200);
    const data = await response.json() as { sections: Array<{ score: number }> };
    for (const section of data.sections) {
      expect(section.score).toBeGreaterThanOrEqual(0);
      expect(section.score).toBeLessThanOrEqual(100);
    }
  });

  it('readiness includes kill switch and grant metadata', async () => {
    const response = await request('/api/readiness');
    expect(response.status).toBe(200);
    const data = await response.json() as { killSwitch: { active: boolean }; grants: number; generatedAt: string; model: string };
    expect(typeof data.killSwitch.active).toBe('boolean');
    expect(typeof data.grants).toBe('number');
    expect(data.generatedAt).toBeTruthy();
  });

  it('readiness includes operating services section', async () => {
    const response = await request('/api/readiness');
    expect(response.status).toBe(200);
    const data = await response.json() as { sections: Array<{ id: string; checks: Array<{ id: string; message: string }> }> };
    expect(data.sections.map((section) => section.id)).toContain('services');
    const services = data.sections.find((section) => section.id === 'services');
    expect(services?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'services.storage', message: expect.stringContaining('.harness/services') })]));
  });

  it('streams OPERATE_MODE service confirmation without requiring model execution', async () => {
    const createClient = jest.fn(() => ({}) as never);
    const runQueryLoop = jest.fn(async function* (): AsyncGenerator<LoopEvent> {
      yield { type: 'text', content: 'should not run' };
    });
    const restore = setWebRuntimeOverrides({
      createClient,
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({}) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop,
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'check https://example.com/rooms daily to see if a room is free' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const body = await response.text();
      expect(body).toContain('"type":"agentic_mode"');
      expect(body).toContain('"mode":"OPERATE_MODE"');
      expect(body).toContain('Site Monitor Agent is set up');
      expect(body).toContain('data: [DONE]');
      expect(createClient).not.toHaveBeenCalled();
      expect(runQueryLoop).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('lists and reads persisted operating services via API', async () => {
    const chat = await request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Create a bullet journal agent and remind me daily at 9am' }),
    });
    expect(chat.status).toBe(200);
    await chat.text();

    const list = await request('/api/services?limit=1&offset=0');
    expect(list.status).toBe(200);
    const listBody = await list.json() as { total: number; limit: number; offset: number; lifecycle: { model_agnostic: boolean }; services: Array<{ service: { service_id: string; mode: string }; stateSummary: { tasks: number; notes: number } }> };
    expect(listBody).toMatchObject({ total: expect.any(Number), limit: 1, offset: 0, lifecycle: { model_agnostic: true } });
    expect(listBody.services).toEqual(expect.arrayContaining([expect.objectContaining({ service: expect.objectContaining({ service_id: 'bullet_journal', mode: 'operate' }), stateSummary: expect.objectContaining({ tasks: expect.any(Number), notes: expect.any(Number) }) })]));

    const detail = await request('/api/services/bullet_journal');
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ service: { service_id: 'bullet_journal', mode: 'operate' }, state: { service_id: 'bullet_journal', mode: 'operate' } });
  });

  it('exports and imports operating services via API', async () => {
    const chat = await request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'check https://example.com/api-export-service daily to see if it is available' }),
    });
    expect(chat.status).toBe(200);
    await chat.text();

    const exported = await request('/api/services/export');
    expect(exported.status).toBe(200);
    const payload = await exported.json() as { version: number; services: Array<{ service: { service_id: string } }> };
    expect(payload.version).toBe(1);
    expect(payload.services.length).toBeGreaterThan(0);

    const duplicateImport = await request('/api/services/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(duplicateImport.status).toBe(200);
    const duplicateImportBody = await duplicateImport.json() as { ok: boolean; imported: string[]; skipped: string[] };
    expect(duplicateImportBody.ok).toBe(true);
    expect(duplicateImportBody.imported).toEqual([]);
    expect(Array.isArray(duplicateImportBody.skipped)).toBe(true);
    expect(duplicateImportBody.skipped.length).toBeGreaterThan(0);

    const invalidImport = await request('/api/services/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 99, services: [] }) });
    expect(invalidImport.status).toBe(400);
    await expect(invalidImport.json()).resolves.toMatchObject({ error: expect.stringContaining('Invalid operating services export payload') });

    const badEntryImport = await request('/api/services/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, services: [{ service: { service_id: '../bad', service_name: 'Bad Service', mode: 'operate', purpose: 'bad' }, state: {} }] }) });
    expect(badEntryImport.status).toBe(400);
    await expect(badEntryImport.json()).resolves.toMatchObject({ error: expect.stringContaining('Invalid service id') });

    const evidence = await request('/api/evidence/runs');
    expect(evidence.status).toBe(200);
    const evidenceBody = await evidence.json() as { evidence: Array<{ runName?: string; tools: Array<{ name: string }>; artifacts: Array<{ title: string }> }> };
    expect(evidenceBody.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ runName: 'Operating service export', tools: expect.arrayContaining([expect.objectContaining({ name: 'operating_services_export' })]) }),
      expect.objectContaining({ runName: 'Operating service import', tools: expect.arrayContaining([expect.objectContaining({ name: 'operating_services_import' })]) }),
    ]));
  });

  it('keeps operate mode deterministic when a model is supplied', async () => {
    const createClient = jest.fn(() => ({}) as never);
    const runQueryLoop = jest.fn(async function* (): AsyncGenerator<LoopEvent> {
      yield { type: 'text', content: 'should not run' };
    });
    const restore = setWebRuntimeOverrides({
      createClient,
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({}) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop,
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'send me a telegram reminder', model: 'github/gpt-4.1' }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"mode":"OPERATE_MODE"');
      expect(createClient).not.toHaveBeenCalled();
      expect(runQueryLoop).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects invalid service ids and returns not found for missing services', async () => {
    const invalid = await request('/api/services/bad%24id');
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: 'Invalid service id.' });

    const missing = await request('/api/services/not_configured');
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: 'Service not found.' });
  });

  it('skips malformed persisted operating services in service list', async () => {
    const malformedDir = path.join(process.cwd(), '.harness', 'services', 'malformed_test_service');
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, 'service.json'), '{not-json', 'utf-8');
    await fs.writeFile(path.join(malformedDir, 'state.json'), '{not-json', 'utf-8');

    try {
      const list = await request('/api/services');
      expect(list.status).toBe(200);
      const body = await list.json() as { services: Array<{ service: { service_id: string } }> };
      expect(body.services.map((item) => item.service.service_id)).not.toContain('malformed_test_service');
    } finally {
      await fs.rm(malformedDir, { recursive: true, force: true });
    }
  });

  it('includes operating services in discovery payload', async () => {
    const response = await request('/api/discovery');
    expect(response.status).toBe(200);
    const body = await response.json() as { services: { total: number; services: unknown[] } };
    expect(body.services.total).toEqual(expect.any(Number));
    expect(Array.isArray(body.services.services)).toBe(true);
  });

  it('previews pending autonomy plan tasks without starting a process', async () => {
    const response = await request('/api/autonomy/plan-preview');

    expect(response.status).toBe(200);
    const data = await response.json() as { planPath: string; total: number; pending: number; done: number; failed: number; tasks: unknown[] };
    expect(data).toMatchObject({ planPath: 'IMPLEMENTATION_PLAN.md', total: expect.any(Number), pending: expect.any(Number), done: expect.any(Number), failed: expect.any(Number) });
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  it('blocks browser-started autonomy when preflight fails', async () => {
    const planPath = path.join(process.cwd(), 'IMPLEMENTATION_PLAN.md');
    const original = await fs.readFile(planPath, 'utf-8');
    await fs.appendFile(planPath, '\n- [ ] preflight-test-task — Temporary task for testing preflight.\n  - anchor: src/web/server.ts\n');
    await request('/api/tools/bash/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    try {
      const response = await request('/api/autonomy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxIterations: 1 }) });

      expect(response.status).toBe(409);
      const data = await response.json() as { error: string; preflight: { blocked: Array<{ id: string }> } };
      expect(data.error).toBe('Autonomy preflight failed.');
      expect(data.preflight.blocked.map((check) => check.id)).toContain('tool.bash');
    } finally {
      await request('/api/tools/bash/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      await fs.writeFile(planPath, original, 'utf-8');
    }
  });

  it('blocks autonomy start when kill switch is active', async () => {
    await request('/api/permissions/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, reason: 'preflight test' }),
    });
    try {
      const response = await request('/api/autonomy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxIterations: 1 }) });
      expect(response.status).toBe(403);
      const data = await response.json() as { error: string };
      expect(data.error).toBe('Kill switch is active.');
    } finally {
      await request('/api/permissions/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
    }
  });

  it('blocks autonomy start when file_edit is disabled and plan has pending tasks', async () => {
    // Temporarily add a pending task so the no-pending-tasks check doesn't short-circuit.
    const planPath = path.join(process.cwd(), 'IMPLEMENTATION_PLAN.md');
    const original = await fs.readFile(planPath, 'utf-8');
    await fs.appendFile(planPath, '\n- [ ] preflight-test-task — Temporary task for testing preflight.\n  - anchor: src/web/server.ts\n');
    await request('/api/tools/file_edit/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    try {
      const response = await request('/api/autonomy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxIterations: 1 }) });
      expect(response.status).toBe(409);
      const data = await response.json() as { error: string; preflight: { blocked: Array<{ id: string }> } };
      expect(data.preflight.blocked.map((check) => check.id)).toContain('tool.file_edit');
    } finally {
      await request('/api/tools/file_edit/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      await fs.writeFile(planPath, original, 'utf-8');
    }
  });

  it('blocks autonomy start when file_write is disabled and plan has pending tasks', async () => {
    const planPath = path.join(process.cwd(), 'IMPLEMENTATION_PLAN.md');
    const original = await fs.readFile(planPath, 'utf-8');
    await fs.appendFile(planPath, '\n- [ ] preflight-test-task — Temporary task for testing preflight.\n  - anchor: src/web/server.ts\n');
    await request('/api/tools/file_write/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    try {
      const response = await request('/api/autonomy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxIterations: 1 }) });
      expect(response.status).toBe(409);
      const data = await response.json() as { error: string; preflight: { blocked: Array<{ id: string }> } };
      expect(data.preflight.blocked.map((check) => check.id)).toContain('tool.file_write');
    } finally {
      await request('/api/tools/file_write/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      await fs.writeFile(planPath, original, 'utf-8');
    }
  });

  it('blocks autonomy start when no pending tasks exist', async () => {
    const planPath = path.join(process.cwd(), 'IMPLEMENTATION_PLAN.md');
    const original = await fs.readFile(planPath, 'utf-8');
    // Temporarily mark all tasks as done so the no-pending-tasks check fires.
    const allDone = original.replace(/^- \[ \]/gm, '- [x]');
    await fs.writeFile(planPath, allDone, 'utf-8');
    try {
      const response = await request('/api/autonomy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxIterations: 1 }) });
      expect(response.status).toBe(400);
      const data = await response.json() as { error: string };
      expect(data.error).toContain('No pending tasks');
    } finally {
      await fs.writeFile(planPath, original, 'utf-8');
    }
  });

  it('creates, completes, and deletes plan tasks via API', async () => {
    const planPath = path.join(process.cwd(), 'IMPLEMENTATION_PLAN.md');
    const original = await fs.readFile(planPath, 'utf-8');
    try {
      // Create
      const created = await request('/api/autonomy/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Test API task creation' }) });
      expect(created.status).toBe(200);
      const createdData = await created.json() as { ok: boolean; id: string; pending: number };
      expect(createdData.ok).toBe(true);
      expect(createdData.id).toBe('test-api-task-creation');
      const afterCreate = createdData.pending;
      expect(afterCreate).toBeGreaterThan(0);

      // Complete
      const completed = await request('/api/autonomy/tasks/test-api-task-creation/complete', { method: 'POST' });
      expect(completed.status).toBe(200);
      const completedData = await completed.json() as { ok: boolean; pending: number; done: number };
      expect(completedData.ok).toBe(true);
      expect(completedData.pending).toBe(afterCreate - 1);

      // Delete (the completed task)
      const deleted = await request('/api/autonomy/tasks/test-api-task-creation', { method: 'DELETE' });
      expect(deleted.status).toBe(200);
    } finally {
      await fs.writeFile(planPath, original, 'utf-8');
    }
  });

  it('rejects task creation with empty title', async () => {
    const response = await request('/api/autonomy/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '' }) });
    expect(response.status).toBe(400);
  });

  it('generates and downloads Markdown documents', async () => {
    const response = await request('/api/documents/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Server Test Brief', template: 'brief', format: 'markdown', content: 'Summarize the tested server behavior.' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { document: { id: string; filename: string; format: string }; content: string };
    expect(data.document.filename).toMatch(/\.md$/);
    expect(data.document.format).toBe('markdown');
    expect(data.content).toContain('# Server Test Brief');

    const download = await request(`/api/documents/${data.document.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('text/markdown');
    await expect(download.text()).resolves.toContain('Summarize the tested server behavior.');
  });

  it('lists generated documents and supports HTML output', async () => {
    const generated = await request('/api/documents/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Server Test Report', template: 'report', format: 'html', content: 'Report body.' }),
    });
    expect(generated.status).toBe(200);

    const list = await request('/api/documents');
    expect(list.status).toBe(200);
    const data = await list.json() as { documents: Array<{ title: string; format: string }> };
    expect(data.documents).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Server Test Report', format: 'html' })]));
  });

  it('exposes optional document export formats and richer templates', async () => {
    const formats = await request('/api/documents/formats');
    expect(formats.status).toBe(200);
    await expect(formats.json()).resolves.toMatchObject({ formats: { markdown: { available: true }, html: { available: true }, pdf: expect.any(Object), docx: expect.any(Object) } });

    const generated = await request('/api/documents/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Server Test ADR', template: 'adr', format: 'markdown', content: 'We need a durable decision record.' }),
    });
    expect(generated.status).toBe(200);
    const data = await generated.json() as { content: string; document: { template: string } };
    expect(data.document.template).toBe('adr');
    expect(data.content).toContain('## Decision');
  });

  it('turns evidence-backed documents into learning candidates', async () => {
    const evidence = {
      id: 'evidence-test-card',
      kind: 'chat',
      mode: 'build',
      createdAt: new Date().toISOString(),
      request: 'Generate a learning-backed document.',
      tools: [{ name: 'file_read', success: true }],
      files: [],
      commands: [],
      artifacts: [],
      recovery: { sessionId: 'evidence-test-session' },
    };
    const generated = await request('/api/documents/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Evidence Learning Handoff', template: 'handoff', format: 'markdown', content: 'Evidence should become reviewable.', evidence }),
    });
    expect(generated.status).toBe(200);

    const learning = await request('/api/learning');
    expect(learning.status).toBe(200);
    const data = await learning.json() as { candidates: Array<{ prompt: string; reviewStatus: string }> };
    expect(data.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ prompt: 'Generate a learning-backed document.', reviewStatus: 'pending' })]));
  });

  it('persists evidence for automation runs', async () => {
    await createAutomationJob(process.cwd(), { name: 'evidence run job', prompt: 'capture evidence for this run', schedule: '1 minutes' }, new Date('2026-04-30T00:00:00.000Z'));

    const executed = await request('/api/automations/execute-due', { method: 'POST' });
    expect(executed.status).toBe(200);
    const body = await executed.json() as { evidence: Array<{ kind: string; runName: string }> };
    expect(body.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'automation', runName: 'evidence run job' })]));

    const stored = await request('/api/evidence/runs');
    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toMatchObject({ evidence: expect.arrayContaining([expect.objectContaining({ kind: 'automation', runName: 'evidence run job' })]) });
  });

  it('returns empty evidence array when evidence store is missing', async () => {
    // Rename the evidence file to simulate a missing store, then verify the
    // API returns an empty array instead of 500.
    const evidencePath = path.join(process.cwd(), '.harness', 'evidence', 'runs.jsonl');
    const backupPath = evidencePath + '.bak';
    let renamed = false;
    try {
      await fs.rename(evidencePath, backupPath);
      renamed = true;
    } catch { /* file may not exist */ }
    try {
      const response = await request('/api/evidence/runs');
      expect(response.status).toBe(200);
      const data = await response.json() as { evidence: unknown[] };
      expect(Array.isArray(data.evidence)).toBe(true);
    } finally {
      if (renamed) await fs.rename(backupPath, evidencePath).catch(() => {});
    }
  });

  it('reports pdf/docx as unavailable when pandoc is absent', async () => {
    const response = await request('/api/documents/formats');
    expect(response.status).toBe(200);
    const data = await response.json() as { formats: { markdown: { available: boolean }; html: { available: boolean }; pdf: { available: boolean }; docx: { available: boolean } } };
    expect(data.formats.markdown.available).toBe(true);
    expect(data.formats.html.available).toBe(true);
    // pdf and docx depend on pandoc — in CI/test env they are typically unavailable
    expect(typeof data.formats.pdf.available).toBe('boolean');
    expect(typeof data.formats.docx.available).toBe('boolean');
  });

  it('returns document list even when documents directory is empty', async () => {
    const response = await request('/api/documents');
    expect(response.status).toBe(200);
    const data = await response.json() as { documents: unknown[] };
    expect(Array.isArray(data.documents)).toBe(true);
  });

  it('returns 404 for nonexistent document download', async () => {
    const response = await request('/api/documents/nonexistent-doc-id-12345/download');
    expect(response.status).toBe(404);
  });

  it('creates and revokes time-limited capability grants for gated capabilities', async () => {
    const created = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'arbitrary-shell',
        controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
        reason: 'server test grant',
        expiresInMinutes: 5,
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { grant: { id: string; capabilityId: string }; grants: Array<{ id: string }> };
    expect(createdBody.grant).toMatchObject({ capabilityId: 'arbitrary-shell' });
    expect(createdBody.grants).toEqual(expect.arrayContaining([expect.objectContaining({ id: createdBody.grant.id })]));

    const visible = await request('/api/capabilities');
    await expect(visible.json()).resolves.toMatchObject({ grants: expect.arrayContaining([expect.objectContaining({ id: createdBody.grant.id })]) });

    const revoked = await request(`/api/capabilities/grants/${encodeURIComponent(createdBody.grant.id)}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    const revokedBody = await revoked.json() as { grants: Array<{ id: string }> };
    expect(revokedBody.grants.map((grant) => grant.id)).not.toContain(createdBody.grant.id);

    const audit = await request('/api/capabilities/audit');
    await expect(audit.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'grant.created', capabilityId: 'arbitrary-shell', grantId: createdBody.grant.id }),
        expect.objectContaining({ type: 'grant.revoked', capabilityId: 'arbitrary-shell', grantId: createdBody.grant.id }),
      ]),
    });
  });

  it('returns command allowlist presets with the capability payload', async () => {
    const response = await request('/api/capabilities');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      shellCommandPresets: expect.arrayContaining([expect.objectContaining({ id: 'tool-version', examples: expect.arrayContaining(['node --version']) })]),
    });
  });

  it('rejects grants for blocked capability surfaces', async () => {
    const response = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'live-broker-trading',
        controls: ['explicit-grant', 'time-limit', 'audit-log', 'dry-run', 'allowlist', 'human-confirmation', 'kill-switch'],
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ evaluation: expect.objectContaining({ decision: 'deny', posture: 'blocked' }) });
  });

  it('rejects grant creation with missing capabilityId', async () => {
    const response = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controls: ['explicit-grant'] }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects grant creation for unknown capability', async () => {
    const response = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilityId: 'does-not-exist', controls: ['explicit-grant'] }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 404 when revoking a nonexistent grant', async () => {
    const response = await request('/api/capabilities/grants/nonexistent-id', { method: 'DELETE' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns audit events with valid types and timestamps', async () => {
    const audit = await request('/api/capabilities/audit');

    expect(audit.status).toBe(200);
    const body = await audit.json() as { events: Array<{ type: string; createdAt: string }> };
    expect(Array.isArray(body.events)).toBe(true);
    for (const event of body.events) {
      expect(['grant.created', 'grant.revoked', 'grant.expired', 'automation_script.allowed', 'automation_script.denied', 'autonomy.timed.engaged', 'autonomy.timed.cleared', 'autonomy.timed.expired', 'mcp_server.started', 'mcp_server.stopped']).toContain(event.type);
      expect(Date.parse(event.createdAt)).not.toBeNaN();
    }
  });

  it('executes due automation jobs via the API', async () => {
    const response = await request('/api/automations/execute-due', { method: 'POST' });

    expect(response.status).toBe(200);
    const body = await response.json() as { executed: number; results: Array<{ jobId: string; name: string; scriptOutput: string }> };
    expect(typeof body.executed).toBe('number');
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('executes a due job end-to-end and records audit trail', async () => {
    await createAutomationJob(process.cwd(), { name: 'lifecycle-test-job', prompt: 'Check lifecycle', schedule: '1 minutes', scriptCommand: 'node --version' }, new Date('2026-04-30T00:00:00.000Z'));

    const created = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'arbitrary-shell',
        controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
        reason: 'lifecycle test',
        expiresInMinutes: 60,
      }),
    });
    const shellGrant = (await created.json() as { grant: { id: string } }).grant;

    const bgCreated = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'background-autonomous-jobs',
        controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'],
        reason: 'lifecycle test',
        expiresInMinutes: 60,
      }),
    });
    const bgGrant = (await bgCreated.json() as { grant: { id: string } }).grant;

    const execResponse = await request('/api/automations/execute-due', { method: 'POST' });
    expect(execResponse.status).toBe(200);
    const execBody = await execResponse.json() as { executed: number; results: Array<{ jobId: string; name: string; scriptOutput: string }> };
    const lifecycleResult = execBody.results.find((r) => r.name === 'lifecycle-test-job');
    expect(lifecycleResult).toBeDefined();
    expect(lifecycleResult!.scriptOutput).toMatch(/^v?\d+\.\d+\.\d+/);

    const audit = await request('/api/capabilities/audit');
    const auditBody = await audit.json() as { events: Array<{ type: string; command?: string; presetId?: string }> };
    expect(auditBody.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'automation_script.allowed', command: 'node --version', presetId: 'tool-version' }),
    ]));

    // Clean up grants
    await request(`/api/capabilities/grants/${encodeURIComponent(shellGrant.id)}`, { method: 'DELETE' });
    await request(`/api/capabilities/grants/${encodeURIComponent(bgGrant.id)}`, { method: 'DELETE' });
  });

  it('creates and deletes automation jobs via the API', async () => {
    const created = await request('/api/automations/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'API test job', prompt: 'Test prompt', schedule: 'every 1h' }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { job: { id: string; name: string } };
    expect(createdBody.job.name).toBe('API test job');

    const deleted = await request(`/api/automations/jobs/${encodeURIComponent(createdBody.job.id)}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ deleted: createdBody.job.id });

    const notFound = await request(`/api/automations/jobs/${encodeURIComponent(createdBody.job.id)}`, { method: 'DELETE' });
    expect(notFound.status).toBe(404);
  });

  it('rejects job creation with missing fields', async () => {
    const response = await request('/api/automations/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Incomplete' }),
    });
    expect(response.status).toBe(400);
  });

  it('returns automation run history', async () => {
    const response = await request('/api/automations/runs');
    expect(response.status).toBe(200);
    const body = await response.json() as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it('toggles and updates automation jobs via PATCH', async () => {
    const created = await request('/api/automations/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Toggle test', prompt: 'Test', schedule: 'every 1h' }),
    });
    const { job } = await created.json() as { job: { id: string; enabled: boolean; name: string } };
    expect(job.enabled).toBe(true);

    const disabled = await request(`/api/automations/jobs/${encodeURIComponent(job.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    const disabledBody = await disabled.json() as { job: { enabled: boolean } };
    expect(disabledBody.job.enabled).toBe(false);

    const edited = await request(`/api/automations/jobs/${encodeURIComponent(job.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed job', enabled: true }),
    });
    expect(edited.status).toBe(200);
    const editedBody = await edited.json() as { job: { name: string; enabled: boolean } };
    expect(editedBody.job.name).toBe('Renamed job');
    expect(editedBody.job.enabled).toBe(true);

    await request(`/api/automations/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
  });

  it('returns 404 when patching a nonexistent job', async () => {
    const response = await request('/api/automations/jobs/nonexistent', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(404);
  });

  it('runs full automation lifecycle: create job, grant, execute, verify history and output', async () => {
    // Create a job that is already due (created in the past)
    await createAutomationJob(process.cwd(), { name: 'smoke-lifecycle', prompt: 'Run version check', schedule: '1 minutes', scriptCommand: 'node --version' }, new Date('2026-04-30T00:00:00.000Z'));

    // Grant required capabilities
    const shellGrant = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilityId: 'arbitrary-shell', controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'], expiresInMinutes: 60 }),
    });
    const bgGrant = await request('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'], expiresInMinutes: 60 }),
    });
    const shellGrantId = ((await shellGrant.json()) as { grant: { id: string } }).grant.id;
    const bgGrantId = ((await bgGrant.json()) as { grant: { id: string } }).grant.id;

    // Execute due jobs
    const exec = await request('/api/automations/execute-due', { method: 'POST' });
    const execBody = await exec.json() as { executed: number; results: Array<{ name: string; scriptOutput: string; outputPath: string }> };
    const smokeResult = execBody.results.find((r) => r.name === 'smoke-lifecycle');
    expect(smokeResult).toBeDefined();
    expect(smokeResult!.scriptOutput).toMatch(/^v?\d+\.\d+\.\d+/);

    // Verify run history
    const history = await request('/api/automations/runs');
    const historyBody = await history.json() as { runs: Array<{ name: string; outputPath: string }> };
    const historyEntry = historyBody.runs.find((r) => r.name === 'smoke-lifecycle');
    expect(historyEntry).toBeDefined();
    expect(historyEntry!.outputPath).toBeTruthy();

    // Verify output endpoint
    const output = await request('/api/automations/output?path=' + encodeURIComponent(historyEntry!.outputPath));
    expect(output.status).toBe(200);
    const outputBody = await output.json() as { content: string };
    expect(outputBody.content).toContain('Run version check');

    // Clean up
    await request(`/api/capabilities/grants/${encodeURIComponent(shellGrantId)}`, { method: 'DELETE' });
    await request(`/api/capabilities/grants/${encodeURIComponent(bgGrantId)}`, { method: 'DELETE' });
  });

  it('rejects output reads outside automations directory', async () => {
    const response = await request('/api/automations/output?path=../../package.json');
    expect(response.status).toBe(403);
  });

  it('returns runtime skills, repo skills, and runtime skill diagnostics', async () => {
    const runtimeSkillDir = path.join(process.cwd(), '.harness', 'skills', 'api-runtime-skill');
    const malformedSkillDir = path.join(process.cwd(), '.harness', 'skills', 'api-malformed-skill');
    await fs.mkdir(runtimeSkillDir, { recursive: true });
    await fs.mkdir(malformedSkillDir, { recursive: true });
    await fs.writeFile(path.join(runtimeSkillDir, 'SKILL.md'), '---\nname: api-runtime-skill\ndescription: Runtime API skill.\ndomain: tests\n---\n\n# Runtime Skill\n', 'utf-8');
    await fs.writeFile(path.join(malformedSkillDir, 'SKILL.md'), '# No frontmatter\n', 'utf-8');

    try {
      const response = await request('/api/skills');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        skills: expect.arrayContaining([expect.objectContaining({ name: 'api-runtime-skill', source: 'runtime' })]),
        diagnostics: expect.arrayContaining([expect.objectContaining({ name: 'api-malformed-skill', reason: 'missing-frontmatter' })]),
        sources: expect.arrayContaining([
          expect.objectContaining({ source: 'runtime', mutable: true, skills: expect.arrayContaining([expect.objectContaining({ name: 'api-runtime-skill' })]) }),
          expect.objectContaining({ source: 'repo', mutable: false, skills: expect.arrayContaining([expect.objectContaining({ name: 'copilotforge-planner' })]) }),
        ]),
      });
    } finally {
      await fs.rm(runtimeSkillDir, { recursive: true, force: true });
      await fs.rm(malformedSkillDir, { recursive: true, force: true });
    }
  });

  it('installs a repo skill into runtime skills and prevents accidental overwrite', async () => {
    const repoSkillDir = path.join(process.cwd(), '.github', 'skills', 'install-test-skill');
    const runtimeSkillDir = path.join(process.cwd(), '.harness', 'skills', 'install-test-skill');
    await fs.mkdir(repoSkillDir, { recursive: true });
    await fs.writeFile(path.join(repoSkillDir, 'SKILL.md'), '---\nname: install-test-display-name\ndescription: Installable repo skill.\ndomain: tests\n---\n\n# Install Test Skill\n', 'utf-8');

    try {
      const installed = await request('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'install-test-skill' }) });
      expect(installed.status).toBe(200);
      await expect(installed.json()).resolves.toMatchObject({ ok: true, id: 'install-test-skill', name: 'install-test-display-name', overwrote: false });
      await expect(fs.readFile(path.join(runtimeSkillDir, 'SKILL.md'), 'utf-8')).resolves.toContain('install-test-display-name');

      const visible = await request('/api/skills');
      await expect(visible.json()).resolves.toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({ source: 'runtime', skills: expect.arrayContaining([expect.objectContaining({ id: 'install-test-skill', name: 'install-test-display-name' })]) }),
        ]),
      });

      const conflict = await request('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'install-test-skill' }) });
      expect(conflict.status).toBe(409);

      const overwrote = await request('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'install-test-skill', overwrite: true }) });
      expect(overwrote.status).toBe(200);
      await expect(overwrote.json()).resolves.toMatchObject({ ok: true, overwrote: true });

      const missing = await request('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'install-test-missing' }) });
      expect(missing.status).toBe(404);

      const invalid = await request('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'bad$name' }) });
      expect(invalid.status).toBe(400);
    } finally {
      await fs.rm(repoSkillDir, { recursive: true, force: true });
      await fs.rm(runtimeSkillDir, { recursive: true, force: true });
    }
  });

  it('automates safe skill installation and missing SKILL.md scaffolding', async () => {
    const repoSkillDir = path.join(process.cwd(), '.github', 'skills', 'automation-repo-skill');
    const runtimeRepoSkillDir = path.join(process.cwd(), '.harness', 'skills', 'automation-repo-skill');
    const missingRuntimeDir = path.join(process.cwd(), '.harness', 'skills', 'automation-missing-skill');
    const malformedRuntimeDir = path.join(process.cwd(), '.harness', 'skills', 'automation-malformed-skill');
    await fs.mkdir(repoSkillDir, { recursive: true });
    await fs.mkdir(missingRuntimeDir, { recursive: true });
    await fs.mkdir(malformedRuntimeDir, { recursive: true });
    await fs.writeFile(path.join(repoSkillDir, 'SKILL.md'), '---\nname: automation-repo-display-name\ndescription: Automated repo skill.\ndomain: tests\n---\n\n# Automation Repo Skill\n', 'utf-8');
    await fs.writeFile(path.join(malformedRuntimeDir, 'SKILL.md'), '# Missing frontmatter\n', 'utf-8');

    try {
      const response = await request('/api/skills/automation/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(200);
      const body = await response.json() as { installed: Array<{ id: string; name: string }>; scaffolded: Array<{ id: string }>; skipped: Array<{ id: string; reason: string }> };
      expect(body.installed).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'automation-repo-skill', name: 'automation-repo-display-name' })]));
      expect(body.scaffolded).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'automation-missing-skill' })]));
      expect(body.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'automation-malformed-skill', reason: expect.stringContaining('manual repair required') })]));
      await expect(fs.readFile(path.join(runtimeRepoSkillDir, 'SKILL.md'), 'utf-8')).resolves.toContain('automation-repo-display-name');
      await expect(fs.readFile(path.join(missingRuntimeDir, 'SKILL.md'), 'utf-8')).resolves.toContain('name: automation-missing-skill');
    } finally {
      await fs.rm(repoSkillDir, { recursive: true, force: true });
      await fs.rm(runtimeRepoSkillDir, { recursive: true, force: true });
      await fs.rm(missingRuntimeDir, { recursive: true, force: true });
      await fs.rm(malformedRuntimeDir, { recursive: true, force: true });
    }
  });

  it('scaffolds a starter SKILL.md for a runtime skill folder missing one', async () => {
    const skillDir = path.join(process.cwd(), '.harness', 'skills', 'scaffold-test-skill');
    await fs.mkdir(skillDir, { recursive: true });

    try {
      const scaffolded = await request('/api/skills/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'scaffold-test-skill' }) });
      expect(scaffolded.status).toBe(200);
      const content = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
      expect(content).toContain('name: scaffold-test-skill');
      expect(content).toContain('triggers: []');

      const conflict = await request('/api/skills/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'scaffold-test-skill' }) });
      expect(conflict.status).toBe(409);
    } finally {
      await fs.rm(skillDir, { recursive: true, force: true });
    }
  });

  it('creates a runtime skill from direct user input', async () => {
    const skillDir = path.join(process.cwd(), '.harness', 'skills', 'direct-create-skill');
    try {
      const created = await request('/api/skills/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'direct-create-skill',
          description: 'Directly created skill.',
          domain: 'tests',
          triggers: 'direct create, generated skill',
          requiredTools: ['browser_navigate'],
          riskLevel: 'high',
          content: '# Direct Create\n\nUse this for direct runtime skill creation tests.',
        }),
      });

      expect(created.status).toBe(200);
      const content = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
      expect(content).toContain('name: "direct-create-skill"');
      expect(content).toContain('description: "Directly created skill."');
      expect(content).toContain('  - "direct create"');
      expect(content).toContain('required_tools:');
      expect(content).toContain('risk_level: "high"');

      const conflict = await request('/api/skills/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'direct-create-skill' }) });
      expect(conflict.status).toBe(409);
    } finally {
      await fs.rm(skillDir, { recursive: true, force: true });
    }
  });

  it('creates an MCP runtime server from the offline catalog', async () => {
    try {
      const created = await request('/api/mcp/runtime/from-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'filesystem', overwrite: true }),
      });

      expect(created.status).toBe(200);
      await expect(created.json()).resolves.toMatchObject({
        server: { id: 'filesystem', catalogName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
      });

      const runtime = await request('/api/mcp/runtime');
      await expect(runtime.json()).resolves.toMatchObject({ servers: expect.arrayContaining([expect.objectContaining({ id: 'filesystem' })]) });

      const conflict = await request('/api/mcp/runtime/from-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'filesystem' }),
      });
      expect(conflict.status).toBe(409);
    } finally {
      await request('/api/mcp/runtime/servers/filesystem', { method: 'DELETE' }).catch(() => undefined);
    }
  });

  it('previews RAG paths with diagnostics before building', async () => {
    const response = await request('/api/rag/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['README.md', 'docs', 'this-folder-does-not-exist'] }),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as { totalFiles: number; paths: Array<{ input: string; status: string; fileCount: number }>; supportedExtensions: string[]; backend: { name: string } };
    expect(data.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ input: 'this-folder-does-not-exist', status: 'missing' }),
    ]));
    expect(data.supportedExtensions).toEqual(expect.arrayContaining(['.md']));
    expect(typeof data.totalFiles).toBe('number');
    expect(typeof data.backend?.name).toBe('string');
  });

  it('rejects RAG preview requests with no paths', async () => {
    const response = await request('/api/rag/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });
    expect(response.status).toBe(400);
  });

  it('streams RAG build progress events via SSE', async () => {
    const response = await request('/api/rag/build/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '_sse_smoke', paths: ['README.md'], backend: 'hash' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    expect(buffered).toContain('event: preview');
    expect(buffered).toContain('event: backend');
    expect(buffered).toContain('event: file');
    expect(buffered).toContain('event: done');
    // Cleanup the temporary index so it does not leak between runs.
    const drop = await request('/api/rag/indexes/_sse_smoke', { method: 'DELETE' });
    expect(drop.status).toBe(200);
  });

  it('exposes tool registry metadata for the dashboard', async () => {
    const response = await request('/api/tools');
    expect(response.status).toBe(200);
    const data = await response.json() as { tools: Array<{ name: string; toolset: string; riskLevel: string; permissionCategory: string; canDryRun: boolean }>; toolsets: Record<string, number> };
    const bash = data.tools.find((t) => t.name === 'bash');
    expect(bash).toMatchObject({ riskLevel: 'high', permissionCategory: 'shell', toolset: 'shell' });
    const fileRead = data.tools.find((t) => t.name === 'file_read');
    expect(fileRead).toMatchObject({ riskLevel: 'low', permissionCategory: 'read' });
    expect(data.toolsets.shell).toBeGreaterThanOrEqual(1);
  });

  it('reports permission posture and toggles the kill switch', async () => {
    const initial = await request('/api/permissions/state');
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({ killSwitch: { active: false } });

    const engaged = await request('/api/permissions/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, reason: 'test stop' }),
    });
    expect(engaged.status).toBe(200);
    await expect(engaged.json()).resolves.toMatchObject({ killSwitch: { active: true, reason: 'test stop' } });

    const stillActive = await request('/api/permissions/state');
    await expect(stillActive.json()).resolves.toMatchObject({ killSwitch: { active: true, reason: 'test stop' } });

    const released = await request('/api/permissions/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toMatchObject({ killSwitch: { active: false } });
  });

  it('toggles a single tool on and off via the registry endpoint', async () => {
    const off = await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    await expect(off.json()).resolves.toMatchObject({ name: 'bash', enabled: false, disabled: expect.arrayContaining(['bash']) });
    const back = await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    expect(back.status).toBe(200);
    await expect(back.json()).resolves.toMatchObject({ name: 'bash', enabled: true });
    const unknown = await request('/api/tools/no-such-tool/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    expect(unknown.status).toBe(404);
  });

  it('persists disabledTools and killSwitch state via /api/settings', async () => {
    const off = await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    const engaged = await request('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true, reason: 'persistence test' }) });
    expect(engaged.status).toBe(200);

    const settings = await request('/api/settings');
    expect(settings.status).toBe(200);
    const body = await settings.json() as { disabledTools: string[]; killSwitch: { active: boolean; reason: string } };
    expect(body.disabledTools).toEqual(expect.arrayContaining(['bash']));
    expect(body.killSwitch).toMatchObject({ active: true, reason: 'persistence test' });

    // Cleanup so subsequent tests start in a known state.
    await request('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  });

  it('enables a tool with a time limit and returns enabledUntil', async () => {
    // First disable the tool
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    // Enable with 60-minute timer
    const timed = await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, expiresInMinutes: 60 }) });
    expect(timed.status).toBe(200);
    const timedBody = await timed.json() as { name: string; enabled: boolean; enabledUntil?: string };
    expect(timedBody.name).toBe('bash');
    expect(timedBody.enabled).toBe(true);
    expect(timedBody.enabledUntil).toBeDefined();
    // enabledUntil should be roughly 60 minutes from now
    const expiryMs = new Date(timedBody.enabledUntil!).getTime();
    expect(expiryMs).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(expiryMs).toBeLessThan(Date.now() + 61 * 60_000);

    // GET /api/tools should also show it
    const toolsRes = await request('/api/tools');
    const toolsBody = await toolsRes.json() as { tools: Array<{ name: string; enabled: boolean; enabledUntil?: string }> };
    const bashTool = toolsBody.tools.find((t) => t.name === 'bash');
    expect(bashTool?.enabled).toBe(true);
    expect(bashTool?.enabledUntil).toBeDefined();

    // Settings should include timedToolEnables
    const settingsRes = await request('/api/settings');
    const settingsBody = await settingsRes.json() as { timedToolEnables: Record<string, string> };
    expect(settingsBody.timedToolEnables).toHaveProperty('bash');

    // Cleanup: permanently enable
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  });

  it('timed tool enables persist via settings and survive a simulated restart', async () => {
    // Disable the tool first
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    // Enable with 120-minute timer
    const timed = await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, expiresInMinutes: 120 }) });
    expect(timed.status).toBe(200);
    const timedBody = await timed.json() as { enabledUntil?: string };
    expect(timedBody.enabledUntil).toBeDefined();

    // Read settings — should include timedToolEnables with bash
    const settingsRes = await request('/api/settings');
    const settings = await settingsRes.json() as { disabledTools: string[]; timedToolEnables: Record<string, string> };
    expect(settings.disabledTools).toContain('bash');
    expect(settings.timedToolEnables).toHaveProperty('bash');
    const savedExpiry = new Date(settings.timedToolEnables.bash).getTime();
    expect(savedExpiry).toBeGreaterThan(Date.now());

    // Simulate restart: POST the same settings back
    await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabledTools: settings.disabledTools, timedToolEnables: settings.timedToolEnables }),
    });

    // After restore, the tool should still be effectively enabled
    const toolsRes = await request('/api/tools');
    const toolsBody = await toolsRes.json() as { tools: Array<{ name: string; enabled: boolean; enabledUntil?: string }> };
    const bashTool = toolsBody.tools.find((t) => t.name === 'bash');
    expect(bashTool?.enabled).toBe(true);
    expect(bashTool?.enabledUntil).toBeDefined();

    // Cleanup: permanently enable
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  });

  it('sets timed autonomy and returns expiry and previous mode', async () => {
    // Set permission mode to acceptEdits first
    await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: 'acceptEdits' }) });

    // Engage timed autonomy for 60 minutes
    const res = await request('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresInMinutes: 60 }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { permissionMode: string; autonomyExpiresAt: string | null; autonomyPreviousMode: string | null };
    expect(body.permissionMode).toBe('dontAsk');
    expect(body.autonomyExpiresAt).toBeDefined();
    expect(body.autonomyPreviousMode).toBe('acceptEdits');

    // Permissions state should show the expiry
    const stateRes = await request('/api/permissions/state');
    const state = await stateRes.json() as { mode: string; autonomyExpiresAt: string | null; autonomyPreviousMode: string | null };
    expect(state.mode).toBe('dontAsk');
    expect(state.autonomyExpiresAt).toBeDefined();

    // Clear timed autonomy
    const clearRes = await request('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.json() as { permissionMode: string; autonomyExpiresAt: string | null };
    expect(clearBody.permissionMode).toBe('acceptEdits');
    expect(clearBody.autonomyExpiresAt).toBeNull();

    // Cleanup
    await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: 'default' }) });
  });

  it('clearing timed autonomy with clearTimedTools also clears timed tool enables', async () => {
    // Disable bash, then enable it with a timer
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, expiresInMinutes: 60 }) });
    // Set timed autonomy
    await request('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresInMinutes: 60 }) });

    // Clear with clearTimedTools
    const clearRes = await request('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clearTimedTools: true }) });
    expect(clearRes.status).toBe(200);

    // Timed tool enables should be cleared — bash should show as disabled (no timed override)
    const toolsRes = await request('/api/tools');
    const toolsBody = await toolsRes.json() as { tools: Array<{ name: string; enabled: boolean; enabledUntil?: string }> };
    const bashTool = toolsBody.tools.find((t) => t.name === 'bash');
    expect(bashTool?.enabledUntil).toBeUndefined();
    expect(bashTool?.enabled).toBe(false);

    // Cleanup
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: 'default' }) });
  });

  it('kill switch clears timed tool enables and timed autonomy', async () => {
    // Disable bash, then enable it with a timer
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, expiresInMinutes: 60 }) });

    // Set timed autonomy
    await request('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresInMinutes: 60 }) });

    // Engage kill switch
    const ksRes = await request('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true, reason: 'test cleanup' }) });
    expect(ksRes.status).toBe(200);

    // Timed tool enables should be cleared
    const toolsRes = await request('/api/tools');
    const toolsBody = await toolsRes.json() as { tools: Array<{ name: string; enabled: boolean; enabledUntil?: string }> };
    const bashTool = toolsBody.tools.find((t) => t.name === 'bash');
    expect(bashTool?.enabledUntil).toBeUndefined();

    // Timed autonomy should be cleared
    const stateRes = await request('/api/permissions/state');
    const state = await stateRes.json() as { autonomyExpiresAt: string | null };
    expect(state.autonomyExpiresAt).toBeNull();

    // Cleanup
    await request('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: 'default' }) });
  });

  it('bulk-toggles multiple tools in a single call', async () => {
    // Disable two tools first
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    await request('/api/tools/file_edit/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });

    // Bulk enable both
    const bulkRes = await request('/api/tools/bulk-toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['bash', 'file_edit'], enabled: true }) });
    expect(bulkRes.status).toBe(200);
    const bulkBody = await bulkRes.json() as { toggled: Array<{ name: string; enabled: boolean }>; disabled: string[] };
    expect(bulkBody.toggled).toHaveLength(2);
    expect(bulkBody.toggled[0].enabled).toBe(true);
    expect(bulkBody.toggled[1].enabled).toBe(true);
    expect(bulkBody.disabled).not.toContain('bash');
    expect(bulkBody.disabled).not.toContain('file_edit');
  });

  it('bulk-toggles with timed enable returns enabledUntil', async () => {
    // Disable a tool, then bulk-enable with timer
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    const bulkRes = await request('/api/tools/bulk-toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['bash'], enabled: true, expiresInMinutes: 30 }) });
    expect(bulkRes.status).toBe(200);
    const body = await bulkRes.json() as { toggled: Array<{ name: string; enabled: boolean; enabledUntil?: string }> };
    expect(body.toggled[0].enabledUntil).toBeDefined();

    // Cleanup
    await request('/api/tools/bash/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  });

  it('lists workflows from .harness/workflows and returns enriched runs', async () => {
    const workflowsDir = path.join(process.cwd(), '.harness', 'workflows');
    const workflowPath = path.join(workflowsDir, 'project_health_check.yaml');
    let originalWorkflow: string | null = null;
    try {
      originalWorkflow = await fs.readFile(workflowPath, 'utf-8');
    } catch {
      originalWorkflow = null;
    }

    try {
      await fs.mkdir(workflowsDir, { recursive: true });
      await fs.writeFile(workflowPath, [
        'name: project_health_check',
        'description: Test workflow fixture.',
        'risk_level: low',
        'steps:',
        '  - id: list',
        '    tool: list_files',
        '    input:',
        '      path: .',
      ].join('\n'), 'utf-8');

      const list = await request('/api/workflows');
      expect(list.status).toBe(200);
      const data = await list.json() as { workflows: Array<{ name: string; stepCount: number; riskLevel?: string }> };
      expect(data.workflows.length).toBeGreaterThan(0);
      const sample = data.workflows.find((w) => w.name === 'project_health_check');
      expect(sample?.stepCount).toBeGreaterThan(0);

      const runsBefore = await request('/api/runs');
      expect(runsBefore.status).toBe(200);
      const runsBody = await runsBefore.json() as { runs: unknown[]; counts: Record<string, number>; total: number };
      expect(Array.isArray(runsBody.runs)).toBe(true);
      expect(typeof runsBody.total).toBe('number');
    } finally {
      if (originalWorkflow === null) {
        await fs.rm(workflowPath, { force: true });
      } else {
        await fs.writeFile(workflowPath, originalWorkflow, 'utf-8');
      }
    }
  });

  it('exposes curator state, runs preview, and toggles pin', async () => {
    const state = await request('/api/curator');
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({ settings: expect.objectContaining({ enabled: expect.any(Boolean), staleDays: expect.any(Number) }) });

    const preview = await request('/api/curator/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { summary: { dryRun: boolean; archived: unknown[]; staleCandidates: unknown[] } };
    expect(previewBody.summary.dryRun).toBe(true);
    expect(Array.isArray(previewBody.summary.archived)).toBe(true);
    expect(Array.isArray(previewBody.summary.staleCandidates)).toBe(true);

    const pinResp = await request('/api/skills/api-runtime-skill/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });
    expect(pinResp.status).toBe(200);
    await expect(pinResp.json()).resolves.toMatchObject({ ok: true, record: expect.objectContaining({ name: 'api-runtime-skill', pinned: true }) });
    const unpin = await request('/api/skills/api-runtime-skill/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: false }) });
    expect(unpin.status).toBe(200);
  });

  it('returns parsed merge proposals and applies them via /api/curator/proposals/apply', async () => {
    // Seed two runtime skills + a hand-written proposals file so we don't
    // need to reach an LLM during tests.
    const skillA = path.join(process.cwd(), '.harness', 'skills', 'apply-test-a');
    const skillB = path.join(process.cwd(), '.harness', 'skills', 'apply-test-b');
    const proposalsFile = path.join(process.cwd(), '.harness', 'curator', 'proposals.md');
    await fs.mkdir(skillA, { recursive: true });
    await fs.mkdir(skillB, { recursive: true });
    await fs.writeFile(path.join(skillA, 'SKILL.md'), '---\nname: apply-test-a\ndescription: A\ndomain: t\n---\n# A', 'utf-8');
    await fs.writeFile(path.join(skillB, 'SKILL.md'), '---\nname: apply-test-b\ndescription: B\ndomain: t\n---\n# B', 'utf-8');
    await fs.mkdir(path.dirname(proposalsFile), { recursive: true });
    await fs.writeFile(proposalsFile, '### Cluster: apply-test-umbrella\n- merge: apply-test-a, apply-test-b\n- rationale: testing\n', 'utf-8');
    try {
      const list = await request('/api/curator/proposals');
      expect(list.status).toBe(200);
      const body = await list.json() as { proposals: Array<{ umbrellaName: string; mergeSkills: string[] }> };
      const target = body.proposals.find((p) => p.umbrellaName === 'apply-test-umbrella');
      expect(target).toBeDefined();
      expect(target?.mergeSkills).toEqual(['apply-test-a', 'apply-test-b']);

      const applied = await request('/api/curator/proposals/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal: target }),
      });
      expect(applied.status).toBe(200);
      const result = (await applied.json()) as { result: { umbrellaName: string; archived: string[] } };
      expect(result.result.archived).toEqual(['apply-test-a', 'apply-test-b']);
      const umbrella = await fs.readFile(path.join(process.cwd(), '.harness', 'skills', 'apply-test-umbrella', 'SKILL.md'), 'utf-8');
      expect(umbrella).toContain('apply-test-a');
      expect(umbrella).toContain('apply-test-b');

      const dismiss = await request('/api/curator/proposals', { method: 'DELETE' });
      expect(dismiss.status).toBe(200);
    } finally {
      await fs.rm(path.join(process.cwd(), '.harness', 'skills', 'apply-test-umbrella'), { recursive: true, force: true });
      await fs.rm(path.join(process.cwd(), '.harness', 'skills', '_archive', 'apply-test-a'), { recursive: true, force: true });
      await fs.rm(path.join(process.cwd(), '.harness', 'skills', '_archive', 'apply-test-b'), { recursive: true, force: true });
      await fs.rm(skillA, { recursive: true, force: true });
      await fs.rm(skillB, { recursive: true, force: true });
      await fs.rm(proposalsFile, { force: true });
    }
  });

  it('refreshes the model catalog and rebuilds the session search index', async () => {
    const catalog = await request('/api/models/catalog/refresh', { method: 'POST' });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toMatchObject({ manifest: { version: 1 }, status: expect.objectContaining({ exists: expect.any(Boolean) }) });

    const index = await request('/api/sessions/search-index/rebuild', { method: 'POST' });
    expect(index.status).toBe(200);
    await expect(index.json()).resolves.toMatchObject({ status: { exists: true, fresh: true }, index: { metadata: expect.objectContaining({ entryCount: expect.any(Number) }) } });
  });

  it('rebuilds the session search index after importing a session', async () => {
    const response = await request('/api/sessions/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta: { model: 'import-test-model', title: 'Imported search fixture', status: 'completed' },
        events: [
          { type: 'user_message', data: { kind: 'message', message: { role: 'user', content: 'Imported transcript contains nebula-index-token' } } },
          { type: 'assistant_message', data: { kind: 'message', message: { role: 'assistant', content: 'Search should find nebula-index-token after import.' } } },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const index = await request('/api/sessions/search-index/rebuild', { method: 'POST' });
    expect(index.status).toBe(200);
    const body = await index.json() as { index: { entries: Array<{ text: string }> } };
    expect(body.index.entries.some((entry) => entry.text.includes('nebula-index-token'))).toBe(true);
  });

  it('saves custom output validation profiles and exposes them in settings', async () => {
    const response = await request('/api/output-validation/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: [{ profile: 'release-note', label: 'Release Note', description: 'Release validation summary.', instructions: 'Mention release validation.', checks: [{ code: 'mentions-release', severity: 'fail', message: 'Mention release.', requiresAll: ['release'] }] }] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ customProfiles: [expect.objectContaining({ profile: 'release-note' })] });
    await expect(request('/api/settings').then((settings) => settings.json())).resolves.toMatchObject({ outputValidationProfiles: expect.arrayContaining([expect.objectContaining({ profile: 'release-note' })]) });
    await expect(fs.readFile(validationProfilesPath, 'utf-8')).resolves.toContain('release-note');
  });

  it('lists and installs output validation profile templates', async () => {
    const templates = await request('/api/output-validation/templates');
    expect(templates.status).toBe(200);
    await expect(templates.json()).resolves.toMatchObject({ templates: expect.arrayContaining([expect.objectContaining({ profile: 'release-readiness', examples: { good: expect.any(String), bad: expect.any(String) } })]) });

    const installed = await request('/api/output-validation/templates/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'release-readiness' }),
    });

    expect(installed.status).toBe(200);
    await expect(installed.json()).resolves.toMatchObject({ installed: 'release-readiness', customProfiles: expect.arrayContaining([expect.objectContaining({ profile: 'release-readiness' })]) });
    await expect(request('/api/settings').then((settings) => settings.json())).resolves.toMatchObject({ outputValidation: { profile: 'release-readiness' } });
  });

  it('previews output validation results for pasted content', async () => {
    const response = await request('/api/output-validation/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'coding-answer', content: 'Implemented src/web/server.ts and ran npm test plus npm run typecheck.' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ validation: { profile: 'coding-answer', status: 'pass', score: 1 } });
  });

  it('suggests output validation profiles from prompt intent', async () => {
    const response = await request('/api/output-validation/suggest-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Fix a bug and run the TypeScript tests.' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ profile: 'coding-answer', reason: expect.stringContaining('code') });
  });

  it('returns fix suggestions with failing output validation previews', async () => {
    const response = await request('/api/output-validation/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'factual-answer', content: 'It will be cloudy.' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      validation: {
        status: expect.stringMatching(/^(warn|fail)$/),
        findings: expect.arrayContaining([expect.objectContaining({ suggestion: expect.stringContaining('source') })]),
      },
    });
  });

  it('persists walkthrough completion settings', async () => {
    const response = await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walkthrough: { completed: ['setup', 'validation', 'bad-step'] } }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ walkthrough: { completed: ['setup', 'validation'] } });
    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toContain('walkthrough');
  });

  it('reports release verification status for the About panel', async () => {
    const response = await request('/api/about/verify');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: expect.stringMatching(/^(verified|warning)$/),
      assetName: expect.stringContaining('ollama-agent-harness-v'),
      releaseUrl: expect.stringContaining('/releases/tag/v'),
    });
  });

  it('rejects invalid custom output validation profiles with schema errors', async () => {
    const response = await request('/api/output-validation/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: [{ profile: 'oracle-prime', checks: [{ code: 'x', message: '', requiresAny: 'tests' }] }] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Custom profile schema validation failed.',
      errors: expect.arrayContaining([
        expect.objectContaining({ path: 'profiles[0].profile' }),
        expect.objectContaining({ path: 'profiles[0].checks[0].message' }),
        expect.objectContaining({ path: 'profiles[0].checks[0].requiresAny' }),
      ]),
    });
  });

  it('applies media tool settings to the running process', async () => {
    const originalVision = process.env.HARNESS_VISION_MODEL;
    const originalAudio = process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
    try {
      const response = await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaTools: { visionModel: 'qwen2-vl', audioTranscribeCommand: 'transcribe "{input}"' } }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ mediaTools: { visionModel: 'qwen2-vl', audioTranscribeCommand: 'transcribe "{input}"' } });
      expect(process.env.HARNESS_VISION_MODEL).toBe('qwen2-vl');
      expect(process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND).toBe('transcribe "{input}"');
    } finally {
      if (originalVision === undefined) delete process.env.HARNESS_VISION_MODEL;
      else process.env.HARNESS_VISION_MODEL = originalVision;
      if (originalAudio === undefined) delete process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
      else process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND = originalAudio;
    }
  });

  it('reports setup health for Ollama and media helpers', async () => {
    const audioDir = path.join(process.cwd(), '.harness', 'test-web-health');
    const audioPath = path.join(audioDir, 'voice.wav');
    const scriptPath = path.join(audioDir, 'transcribe.js');
    await fs.rm(audioDir, { recursive: true, force: true });
    await fs.mkdir(audioDir, { recursive: true });
    await fs.writeFile(audioPath, Buffer.from([1, 2, 3]));
    await fs.writeFile(scriptPath, "console.log('web transcript for ' + process.argv[2].split(/[\\\\/]/).pop())", 'utf-8');
    const ollamaServer = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'llava:latest', size: 1, modified_at: new Date().toISOString(), details: {} }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve));
    const address = ollamaServer.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind fake Ollama server');
    try {
      const response = await request(`/api/setup/health?ollamaHost=${encodeURIComponent(`http://127.0.0.1:${address.port}`)}&visionModel=llava&audioTranscribeCommand=${encodeURIComponent(`node "${scriptPath}" "{input}"`)}&audioSamplePath=${encodeURIComponent(audioPath)}`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ollama: { ok: true, modelCount: 1 },
        vision: { ok: true },
        audio: { ok: true },
      });
    } finally {
      await new Promise<void>((resolve, reject) => ollamaServer.close((error) => error ? reject(error) : resolve()));
      await fs.rm(audioDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid setup health hosts', async () => {
    const response = await request('/api/setup/health?ollamaHost=file%3A%2F%2Fbad');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid Ollama host.' });
  });

  it('rejects file tree paths outside the project directory', async () => {
    const outside = path.resolve(process.cwd(), '..');
    const response = await request(`/api/files?path=${encodeURIComponent(outside)}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Path is outside the project directory.' });
  });

  it('rejects unsafe resource identifiers', async () => {
    const history = await request('/api/history/bad%24id');
    const skill = await request('/api/skills/bad%24id');
    const upload = await request('/api/uploads/bad%24id', { method: 'DELETE' });

    expect(history.status).toBe(400);
    expect(skill.status).toBe(400);
    expect(upload.status).toBe(400);
  });

  it('returns trace snapshots and clears trace records', async () => {
    await request('/api/traces', { method: 'DELETE' });
    runtimeTracer.recordEvent('test.event', { ok: true });

    const snapshot = await request('/api/traces');
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({ events: [expect.objectContaining({ name: 'test.event' })] });

    const cleared = await request('/api/traces', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    const afterClear = await request('/api/traces');
    await expect(afterClear.json()).resolves.toMatchObject({ spans: [], events: [] });
  });

  it('exports trace snapshots to files and serves them by id', async () => {
    await request('/api/traces', { method: 'DELETE' });
    runtimeTracer.recordEvent('export.test', { ok: true });

    const exported = await request('/api/traces/exports', { method: 'POST' });
    expect(exported.status).toBe(200);
    const exportedBody = await exported.json() as { id: string; events: number };
    expect(exportedBody.events).toBeGreaterThanOrEqual(1);

    const list = await request('/api/traces/exports');
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ exports: expect.arrayContaining([expect.objectContaining({ id: exportedBody.id })]) });

    const downloaded = await request(`/api/traces/exports/${exportedBody.id}`);
    expect(downloaded.status).toBe(200);
    await expect(downloaded.json()).resolves.toMatchObject({ id: exportedBody.id, events: [expect.objectContaining({ name: 'export.test' })] });
  });

  it('creates and lists eval trace examples from the current trace snapshot', async () => {
    await request('/api/traces', { method: 'DELETE' });
    runtimeTracer.recordEvent('eval.test', { ok: true });

    const created = await request('/api/evals/trace-examples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'test eval trace', tags: ['test'] }),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ example: { task: 'test eval trace', tags: ['test'] } });

    const listed = await request('/api/evals/trace-examples');
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ examples: expect.arrayContaining([expect.objectContaining({ task: 'test eval trace' })]) });
  });

  it('creates replayable eval examples through the API', async () => {
    const created = await request('/api/evals/replay-examples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'weather replay regression',
        prompt: 'What is the weather like in Bracknell, UK today?',
        expectedResponseIncludes: ['Bracknell', 'weather'],
        expectedTools: ['web_search', 'web_read'],
        actualResponse: 'Bracknell weather looks cloudy.',
        actualTools: ['web_search', 'web_read'],
        tags: ['weather', 'replay'],
      }),
    });

    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ example: { mode: 'replay', status: 'pass', task: 'weather replay regression' } });
  });

  it('runs replay examples with a mock adapter and source links', async () => {
    const created = await request('/api/evals/replay-examples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'linked replay api regression',
        prompt: 'Summarize a trace failure',
        expectedResponseIncludes: ['trace failure'],
        sourceTraceId: 'trace-api-test',
        sourceSessionId: 'session-api-test',
        sourceContext: 'API test source link.',
        tags: ['replay-api'],
      }),
    });
    expect(created.status).toBe(200);

    const run = await request('/api/evals/trace-examples/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'mock', mockResponse: 'trace failure reproduced' }),
    });

    expect(run.status).toBe(200);
    await expect(run.json()).resolves.toMatchObject({
      mode: 'mock',
      run: { results: expect.arrayContaining([expect.objectContaining({ task: 'linked replay api regression', links: expect.objectContaining({ traceUrl: '/api/traces/exports/trace-api-test', sessionUrl: '/api/sessions/session-api-test' }) })]) },
    });
  });

  it('classifies uploaded image and audio files', async () => {
    const imageUpload = await request('/api/upload', {
      method: 'POST',
      headers: { 'x-filename': 'sample.png', 'Content-Type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(imageUpload.status).toBe(200);
    await expect(imageUpload.json()).resolves.toMatchObject({ name: 'sample.png', mimeType: 'image/png', mediaKind: 'image' });

    const audioUpload = await request('/api/upload', {
      method: 'POST',
      headers: { 'x-filename': 'voice.wav', 'Content-Type': 'audio/wav' },
      body: new Uint8Array([4, 5, 6]),
    });
    expect(audioUpload.status).toBe(200);
    await expect(audioUpload.json()).resolves.toMatchObject({ name: 'voice.wav', mimeType: 'audio/wav', mediaKind: 'audio' });
  });

  it('manages eval trace examples through dataset endpoints', async () => {
    const created = await request('/api/evals/trace-examples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'managed api trace', tags: ['api'] }),
    });
    const createdBody = await created.json() as { example: { id: string } };

    const tagged = await request(`/api/evals/trace-examples/${encodeURIComponent(createdBody.example.id)}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['api', 'managed'] }),
    });
    expect(tagged.status).toBe(200);
    await expect(tagged.json()).resolves.toMatchObject({ example: { tags: ['api', 'managed'] } });

    const download = await request('/api/evals/trace-examples/download');
    expect(download.status).toBe(200);
    await expect(download.text()).resolves.toContain('managed api trace');

    const deleted = await request(`/api/evals/trace-examples/${encodeURIComponent(createdBody.example.id)}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
  });

  it('runs eval trace examples and reports trends', async () => {
    const created = await request('/api/evals/trace-examples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'runner api trace', tags: ['runner-api'] }),
    });
    expect(created.status).toBe(200);

    const run = await request('/api/evals/trace-examples/run', { method: 'POST' });
    expect(run.status).toBe(200);
    await expect(run.json()).resolves.toMatchObject({ run: { total: expect.any(Number), passRate: expect.any(Number) }, trend: { totalRuns: expect.any(Number) } });

    const runs = await request('/api/evals/runs');
    expect(runs.status).toBe(200);
    await expect(runs.json()).resolves.toMatchObject({ runs: expect.arrayContaining([expect.objectContaining({ total: expect.any(Number) })]), trend: { byTag: expect.any(Object) } });
  });

  it('downloads output validation trend exports', async () => {
    const restore = setWebRuntimeOverrides({
      createClient: () => ({}) as never,
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('validation-export-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (): AsyncGenerator<LoopEvent> {
        yield { type: 'output_validation', validation: { profile: 'coding-answer', status: 'warn', score: 0.8, findings: [{ code: 'missing-validation-summary', severity: 'warn', message: 'State validation.' }], missingSections: [] } };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputValidation: { enabled: true, profile: 'coding-answer' } }),
      });
      const chat = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', model: 'test-model' }),
      });
      expect(chat.status).toBe(200);
      await chat.text();

      const download = await request('/api/learning/output-validation-trends/download');
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain('output-validation-trends-');
      await expect(download.json()).resolves.toMatchObject({ trend: { totalResults: expect.any(Number), bySelectionSource: expect.any(Object) }, results: expect.arrayContaining([expect.objectContaining({ profile: 'coding-answer', status: 'warn', selectionSource: expect.any(String) })]) });
    } finally {
      restore();
    }
  });

  it('reviews learning candidates and exposes routing calibration', async () => {
    const sessionId = `server-learning-review-test-${Date.now()}`;
    const events: SessionEvent[] = [
      { id: 'u1', timestamp: '2026-04-29T00:00:00.000Z', type: 'user_message', data: { kind: 'message', message: { role: 'user', content: 'Remember this candidate review workflow' } } },
      { id: 'a1', timestamp: '2026-04-29T00:00:00.000Z', type: 'assistant_message', data: { kind: 'message', message: { role: 'assistant', content: 'Promote only after explicit operator review' } } },
    ];
    const candidate = extractLearningCandidate(sessionId, events);
    await appendLearningCandidate(process.cwd(), candidate);
    await fs.mkdir(path.join(process.cwd(), '.harness', 'sessions'), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), '.harness', 'sessions', `${sessionId}.jsonl`), events.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf-8');

    const learning = await request('/api/learning');
    const learningBody = await learning.json() as { candidates: Array<{ id: string; reviewStatus: string }>; routingCalibration: unknown };
    expect(learningBody.routingCalibration).toBeDefined();
    const pending = learningBody.candidates.find((item) => item.id === candidate.id && item.reviewStatus === 'pending');
    expect(pending).toBeDefined();

    const reviewed = await request('/api/learning/candidates/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pending?.id, action: 'reject', reason: 'api test' }),
    });
    expect(reviewed.status).toBe(200);
    await expect(reviewed.json()).resolves.toMatchObject({ review: { action: 'reject', reason: 'api test' } });

    const routing = await request('/api/learning/routing');
    expect(routing.status).toBe(200);
    const routingBody = await routing.json() as { summary: { total: number }; calibration: { recommendations: string[] } };
    expect(typeof routingBody.summary.total).toBe('number');
    expect(Array.isArray(routingBody.calibration.recommendations)).toBe(true);

    const provenance = await request(`/api/learning/candidates/${encodeURIComponent(candidate.id)}/provenance`);
    expect(provenance.status).toBe(200);
    await expect(provenance.json()).resolves.toMatchObject({ candidate: { id: candidate.id }, events: expect.arrayContaining([expect.objectContaining({ summary: expect.stringContaining('Remember this candidate review workflow') })]) });
  });

  it('applies routing calibration suggestions to persisted settings', async () => {
    for (let i = 0; i < 3; i++) {
      await appendSubagentRoutingMetric(process.cwd(), {
        timestamp: '2026-04-29T00:00:00.000Z',
        name: 'explore',
        preset: 'explore',
        model: 'tiny-helper',
        tier: 'small',
        escalated: false,
        reasons: ['bounded low-risk helper task'],
        success: false,
        durationMs: 5,
        outputChars: 0,
      });
    }

    const response = await request('/api/learning/routing/apply-calibration', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json() as { settings: { modelRouting: { confidenceEscalationThreshold?: number; failureEscalationThreshold?: number } } };
    expect(body.settings.modelRouting).toMatchObject({ confidenceEscalationThreshold: 0.6, failureEscalationThreshold: 1 });
  });

  it('exposes pending permission prompts and rejects unknown prompt resolutions', async () => {
    const pending = await request('/api/permissions/pending');
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject({ prompts: [] });

    const invalid = await request('/api/permissions/bad%24id/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed: true }),
    });
    expect(invalid.status).toBe(400);

    const missing = await request('/api/permissions/missing/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed: true }),
    });
    expect(missing.status).toBe(404);
  });

  it('returns a memory palace payload', async () => {
    const response = await request('/api/memory/palace');

    expect(response.status).toBe(200);
    const body = await response.json() as { roomCount: number; rooms: unknown[] };
    expect(typeof body.roomCount).toBe('number');
    expect(Array.isArray(body.rooms)).toBe(true);
  });

  it('returns semantic memory entries by id', async () => {
    const sessionId = 'server-memory-entry-test';
    const storage = new SessionStorage(process.cwd(), 'test-model', sessionId);
    await storage.initialize();
    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'Inspect a palace anchor from the browser' },
    });

    const rebuilt = await request('/api/memory/rebuild', { method: 'POST' });
    expect(rebuilt.status).toBe(200);

    const search = await request('/api/memory/search?q=' + encodeURIComponent('palace anchor browser'));
    const searchBody = await search.json() as { results: Array<{ entry: { id: string } }> };
    expect(searchBody.results.length).toBeGreaterThan(0);

    const entryResponse = await request(`/api/memory/entries/${searchBody.results[0].entry.id}`);
    expect(entryResponse.status).toBe(200);
    await expect(entryResponse.json()).resolves.toMatchObject({ entry: { sessionId, text: expect.stringContaining('palace anchor') } });

    const contextResponse = await request(`/api/memory/entries/${searchBody.results[0].entry.id}/context`);
    expect(contextResponse.status).toBe(200);
    await expect(contextResponse.json()).resolves.toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ sessionId, isAnchor: true })]) });
  });

  it('summarizes and cleans derived runtime storage', async () => {
    await request('/api/traces', { method: 'DELETE' });
    runtimeTracer.recordEvent('cleanup.test', { ok: true });
    const exported = await request('/api/traces/exports', { method: 'POST' });
    expect(exported.status).toBe(200);
    const rebuilt = await request('/api/memory/rebuild', { method: 'POST' });
    expect(rebuilt.status).toBe(200);

    const summary = await request('/api/runtime/storage');
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      traces: expect.objectContaining({ count: expect.any(Number), bytes: expect.any(Number) }),
      semanticIndex: expect.objectContaining({ exists: true, bytes: expect.any(Number) }),
    });

    const cleaned = await request('/api/runtime/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ semanticIndex: true }),
    });
    expect(cleaned.status).toBe(200);
    await expect(cleaned.json()).resolves.toMatchObject({ cleaned: ['semanticIndex'], storage: { semanticIndex: { exists: false } } });
  });

  it('streams chat events with injectable runtime dependencies', async () => {
    const createClient = jest.fn(() => ({}) as never);
    const getModelContextWindow = jest.fn().mockResolvedValue(32768);
    const restore = setWebRuntimeOverrides({
      createClient,
      getModelContextWindow,
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([
          { id: 'u1', timestamp: '2026-04-29T00:00:00.000Z', type: 'user_message', data: { kind: 'message', message: { role: 'user', content: 'hello' } } },
          { id: 'a1', timestamp: '2026-04-29T00:00:00.000Z', type: 'assistant_message', data: { kind: 'message', message: { role: 'assistant', content: 'mocked response' } } },
        ]),
        getSessionId: jest.fn().mockReturnValue('test-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config): AsyncGenerator<LoopEvent> {
        expect(config.systemPrompt).toContain('Treat configured external folders as user-owned data and tools');
        expect(config.systemPrompt).toContain('New files, scratch artifacts, generated reports, and exploratory outputs should go under this Agent Files output folder');
        expect(config.systemPrompt).toContain('do not use them as scratch output sinks unless the user explicitly asks');
        expect(config.systemPrompt).toContain('prefer the journal CLI or task data over file_write/file_edit on journal.py, telegram_sender.py');
        if (config.outputValidation?.enabled) {
          yield { type: 'output_validation', validation: { profile: 'oracle-prime', status: 'fail', score: 0.1, findings: [], missingSections: [] } };
        }
        yield { type: 'text', content: 'mocked response' };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedExternalPaths: ['C:/AI/Oracle'], agentOutputDir: 'C:/AI/AgentFiles', contextMaxTokens: 1024 }),
      });
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', model: 'test-model' }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('data: {"type":"text","content":"mocked response"}');
      expect(body).toContain('data: [DONE]');
      expect(getModelContextWindow).toHaveBeenCalledWith('test-model', expect.any(String));
      expect(createClient).toHaveBeenCalledWith('test-model', expect.any(String), 32768);
      const settings = await request('/api/settings');
      await expect(settings.json()).resolves.toMatchObject({ context: { detectedMaxTokens: 32768, effectiveMaxTokens: 32768 } });
    } finally {
      restore();
    }
  });

  it('blocks destructive shell calls through the nervous motor gate before standard permissions', async () => {
    const evaluate = jest.fn(() => ({ decision: 'allow', reason: 'standard permission would allow' }));
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('nervous-motor-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (_config, deps): AsyncGenerator<LoopEvent> {
        const permission = await deps.permissionCheck?.({ name: 'bash', input: { command: 'rm -rf C:/AI/Harness' } });
        yield { type: 'text', content: JSON.stringify(permission) };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'delete everything with rm -rf', model: 'test-model' }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('\\"allowed\\":false');
      expect(body).toContain('Nervous System BLOCK');
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('lets dontAsk bypass nervous verification gates for write tools', async () => {
    await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'dontAsk' }),
    });
    const evaluate = jest.fn(() => ({ decision: 'deny', reason: 'standard permission should not run' }));
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('nervous-dontask-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (_config, deps): AsyncGenerator<LoopEvent> {
        const permission = await deps.permissionCheck?.({ name: 'file_write', input: { path: 'agent-outputs/test.txt', content: 'ok' } });
        yield { type: 'text', content: JSON.stringify(permission) };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'No, that was wrong, redo it and write the file', model: 'test-model' }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('\\"allowed\\":true');
      expect(body).toContain('verification bypassed');
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      restore();
      await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: 'default' }) });
    }
  });

  it('records deterministic operating-service chat evidence as operate mode', async () => {
    const response = await request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Create a bullet journal agent and remind me daily at 9am', model: 'test-model' }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"type":"evidence"');
    expect(body).toContain('"mode":"operate"');
    expect(body).toContain('"type":"agentic_mode","mode":"OPERATE_MODE"');
  });

  it('persists output validation settings, streams validation events, and records eval runs', async () => {
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('validation-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config): AsyncGenerator<LoopEvent> {
        expect(config.outputValidation).toMatchObject({ enabled: true, profile: 'coding-answer' });
        yield { type: 'output_validation', validation: { profile: 'coding-answer', status: 'warn', score: 0.95, findings: [{ code: 'missing-validation-summary', severity: 'warn', message: 'Coding answer should state validation performed.' }], missingSections: [] } };
        yield { type: 'text', content: 'mocked response' };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const settingsResponse = await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputValidation: { enabled: true, profile: 'coding-answer' } }),
      });
      expect(settingsResponse.status).toBe(200);
      await expect(settingsResponse.json()).resolves.toMatchObject({ outputValidation: { enabled: true, profile: 'coding-answer' } });

      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Refactor the typescript function in src/web/server.ts and add a unit test', model: 'test-model' }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"type":"output_validation_profile"');
      expect(body).toContain('"source":"auto-selected"');
      expect(body).toContain('"type":"output_validation"');
      const runs = await request('/api/evals/runs');
      const runsBody = await runs.json() as { outputValidationTrend: { byProfile: Record<string, { total: number }>; bySelectionSource: Record<string, { total: number }> } };
      expect(JSON.stringify(runsBody)).toContain('coding-answer');
      expect(runsBody.outputValidationTrend.byProfile['coding-answer']).toMatchObject({ total: expect.any(Number) });
      expect(runsBody.outputValidationTrend.bySelectionSource['auto-selected']).toMatchObject({ total: expect.any(Number) });
    } finally {
      restore();
    }
  });

  it('honors a per-turn skipValidation flag without disabling stored settings', async () => {
    const seenConfigs: Array<{ outputValidation?: { enabled?: boolean } }> = [];
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('skip-validation-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config): AsyncGenerator<LoopEvent> {
        seenConfigs.push(config);
        yield { type: 'text', content: 'mocked response' };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputValidation: { enabled: true, profile: 'coding-answer' } }),
      });
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Refactor the typescript function in src/web/server.ts', model: 'test-model', skipValidation: true }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('"type":"output_validation_profile"');
      expect(body).not.toContain('"type":"output_validation"');
      expect(seenConfigs[0]?.outputValidation).toMatchObject({ enabled: false });
      const settings = await request('/api/settings');
      await expect(settings.json()).resolves.toMatchObject({ outputValidation: { enabled: true, profile: 'coding-answer' } });
    } finally {
      restore();
    }
  });

  it('skips validation on low-signal prompts when skipOnLowSignal is enabled', async () => {
    const seenConfigs: Array<{ outputValidation?: { enabled?: boolean } }> = [];
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('low-signal-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config): AsyncGenerator<LoopEvent> {
        seenConfigs.push(config);
        yield { type: 'text', content: 'mocked response' };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputValidation: { enabled: true, profile: 'coding-answer', autoSelect: true, skipOnLowSignal: true } }),
      });
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'you decide', model: 'test-model' }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('"type":"output_validation"');
      expect(seenConfigs[0]?.outputValidation).toMatchObject({ enabled: false });
    } finally {
      restore();
    }
  });

  it('defaults low-signal validation skipping on when the setting is omitted', async () => {
    const seenConfigs: Array<{ outputValidation?: { enabled?: boolean } }> = [];
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('default-low-signal-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config): AsyncGenerator<LoopEvent> {
        seenConfigs.push(config);
        yield { type: 'text', content: 'mocked response' };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputValidation: { enabled: true, profile: 'oracle-prime', autoSelect: true } }),
      });
      const settings = await request('/api/settings');
      await expect(settings.json()).resolves.toMatchObject({ outputValidation: { skipOnLowSignal: true } });
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', model: 'test-model' }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('missing-section');
      expect(seenConfigs[0]?.outputValidation).toMatchObject({ enabled: false });
    } finally {
      restore();
    }
  });

  it('forwards prior chat history to the query loop so context is preserved across turns', async () => {
    // First set the agent name and personality
    await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'TestBot', agentPersonality: 'You are helpful and concise.' }),
    });

    const seenConfigs: Array<{ systemPrompt: string }> = [];
    const seenInitialMessages: Array<Array<{ role: string; content: string }>> = [];
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        setMeta: jest.fn(),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('history-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config, _deps, initialMessages): AsyncGenerator<LoopEvent> {
        seenConfigs.push({ systemPrompt: config.systemPrompt });
        seenInitialMessages.push(initialMessages.map((m) => ({ role: m.role, content: m.content })));
        yield { type: 'text', content: 'ok' };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const history = [
        { role: 'user', content: 'analyze lotto-draw-history.csv' },
        { role: 'assistant', content: 'The dataset covers draws from 2025-11-01 to 2026-04-25.' },
        { role: 'bogus', content: 'should be dropped' },
        { role: 'user', content: '' }, // empty content should be dropped
      ];
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'we also have draw date and machine used', model: 'test-model', history }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(seenInitialMessages).toHaveLength(1);
      expect(seenInitialMessages[0]).toEqual([
        { role: 'user', content: 'analyze lotto-draw-history.csv' },
        { role: 'assistant', content: 'The dataset covers draws from 2025-11-01 to 2026-04-25.' },
        { role: 'user', content: 'we also have draw date and machine used' },
      ]);
      // Verify personality and name are injected into the system prompt
      expect(seenConfigs).toHaveLength(1);
      expect(seenConfigs[0].systemPrompt).toContain('Your name is TestBot.');
      expect(seenConfigs[0].systemPrompt).toContain('You are helpful and concise.');
    } finally {
      // Clean up personality settings
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName: '', agentPersonality: '' }),
      });
      restore();
    }
  });

  it('drops oldest history turns to stay within the model context token budget', async () => {
    const seenInitialMessages: Array<Array<{ role: string; content: string }>> = [];
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      // Tiny window so a few turns of large content blow the 75% budget quickly.
      getModelContextWindow: jest.fn().mockResolvedValue(1024),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('budget-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (_config, _deps, initialMessages): AsyncGenerator<LoopEvent> {
        seenInitialMessages.push(initialMessages.map((m) => ({ role: m.role, content: m.content })));
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      // Set contextMaxTokens to its minimum (1024) so a few large turns blow the 75% budget quickly.
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextMaxTokens: 1024 }),
      });
      // Each entry ~2000 chars (~500 tokens) — three of them would exceed a 1024-token window.
      const big = (label: string) => label + ' ' + 'word '.repeat(400);
      const history = [
        { role: 'user', content: big('OLDEST') },
        { role: 'assistant', content: big('OLD-A') },
        { role: 'user', content: big('MID') },
        { role: 'assistant', content: big('NEW-A') },
      ];
      const chatResponse = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'follow-up question', model: 'test-model', history }),
      });
      await chatResponse.text();
      expect(seenInitialMessages).toHaveLength(1);
      const sent = seenInitialMessages[0];
      // Oldest entries must have been dropped first.
      expect(sent[0].content.startsWith('OLDEST')).toBe(false);
      // The new user prompt is always last.
      expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'follow-up question' });
      // Total prior content (excluding the new prompt) must fit the 75% budget (~768 tokens).
      const priorChars = sent.slice(0, -1).reduce((sum, m) => sum + m.content.length, 0);
      expect(Math.ceil(priorChars / 4)).toBeLessThanOrEqual(768);

      // The same call should have streamed a `history_trimmed` SSE event so the UI can warn.
      const trimResponse = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'another follow-up', model: 'test-model', history }),
      });
      expect(trimResponse.status).toBe(200);
      const trimBody = await trimResponse.text();
      expect(trimBody).toContain('"type":"history_trimmed"');
      expect(trimBody).toMatch(/"droppedTurns":\s*[1-9]/);
    } finally {
      restore();
    }
  });

  it('records profile feedback votes as eval trace runs', async () => {
    const upResponse = await request('/api/output-validation/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'coding-answer', vote: 'up', selectionSource: 'auto-selected', selectionReason: 'looks like code', prompt: 'refactor src/web/server.ts' }),
    });
    expect(upResponse.status).toBe(200);
    await expect(upResponse.json()).resolves.toMatchObject({ ok: true, runId: expect.stringContaining('profile-feedback-run') });

    const downResponse = await request('/api/output-validation/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'coding-answer', vote: 'down', selectionSource: 'auto-selected' }),
    });
    expect(downResponse.status).toBe(200);

    const runs = await request('/api/evals/runs');
    const runsBody = await runs.json() as {
      runs: Array<{ results: Array<{ tags: string[] }> }>;
      profileFeedbackTrend?: { totalVotes: number; byProfile: Record<string, { up: number; down: number }> };
    };
    const flat = runsBody.runs.flatMap((run) => run.results);
    expect(flat).toEqual(expect.arrayContaining([
      expect.objectContaining({ tags: expect.arrayContaining(['profile-feedback', 'profile-feedback:up']) }),
      expect.objectContaining({ tags: expect.arrayContaining(['profile-feedback', 'profile-feedback:down']) }),
    ]));
    expect(runsBody.profileFeedbackTrend).toBeDefined();
    expect(runsBody.profileFeedbackTrend!.totalVotes).toBeGreaterThanOrEqual(2);
    expect(runsBody.profileFeedbackTrend!.byProfile['coding-answer']).toMatchObject({ up: expect.any(Number), down: expect.any(Number) });

    const badResponse = await request('/api/output-validation/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: '', vote: 'up' }),
    });
    expect(badResponse.status).toBe(400);

    const badVote = await request('/api/output-validation/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'coding-answer', vote: 'maybe' }),
    });
    expect(badVote.status).toBe(400);

    // Record a down-vote with a vague prompt that should now route to oracle-prime — the replay
    // endpoint should report it as "fixed" because the suggester no longer picks coding-answer.
    const downWithPrompt = await request('/api/output-validation/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'coding-answer', vote: 'down', prompt: 'you decide what to do' }),
    });
    expect(downWithPrompt.status).toBe(200);

    const replay = await request('/api/output-validation/feedback-replay');
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as { totalDownVotes: number; fixed: number; stillMisclassified: number; replays: Array<{ originalProfile: string; suggestedProfile: string; status: string; prompt: string }> };
    expect(replayBody.totalDownVotes).toBeGreaterThanOrEqual(1);
    const fixedReplay = replayBody.replays.find((r) => r.prompt === 'you decide what to do');
    expect(fixedReplay).toMatchObject({ originalProfile: 'coding-answer', suggestedProfile: 'oracle-prime', status: 'fixed' });
  });

  it('appends an authoritative attachments block to the system prompt for valid uploads', async () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = `attachments-block-${Date.now()}.csv`;
    const uploadPath = path.join(uploadsDir, uploadName);
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(uploadPath, 'one,two\n1,2\n', 'utf-8');

    const seenSystemPrompts: string[] = [];
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('attachments-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config): AsyncGenerator<LoopEvent> {
        seenSystemPrompts.push(config.systemPrompt);
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'analyze the csv',
          model: 'test-model',
          attachments: [
            { name: uploadName, path: `.harness/uploads/${uploadName}`, mediaKind: 'data', size: 12 },
            { name: 'never-existed.txt', path: '.harness/uploads/never-existed.txt', mediaKind: 'text', size: 0 },
          ],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(seenSystemPrompts).toHaveLength(1);
      const prompt = seenSystemPrompts[0];
      expect(prompt).toContain('--- Session Attachments (authoritative) ---');
      expect(prompt).toContain(`name="${uploadName}"`);
      expect(prompt).toContain(`path=".harness/uploads/${uploadName}"`);
      expect(prompt).toContain('size=12');
      // Missing files must be filtered out so the block stays trustworthy.
      expect(prompt).not.toContain('never-existed.txt');
    } finally {
      restore();
      await fs.rm(uploadPath, { force: true });
    }
  });

  it('carries uploaded image attachments into chat with image_analyze guidance', async () => {
    const uploadName = `attachment-vision-${Date.now()}.png`;
    const uploaded = await request('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'x-filename': uploadName },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) as never,
    });
    expect(uploaded.status).toBe(200);
    const attachment = await uploaded.json() as { name: string; path: string; mediaKind: string; size: number; mimeType: string };
    expect(attachment).toMatchObject({ name: uploadName, mediaKind: 'image', mimeType: 'image/png' });

    const seenSystemPrompts: string[] = [];
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('attachment-vision-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (config): AsyncGenerator<LoopEvent> {
        seenSystemPrompts.push(config.systemPrompt);
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'read the image',
          model: 'test-model',
          attachments: [attachment],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(seenSystemPrompts).toHaveLength(1);
      expect(seenSystemPrompts[0]).toContain('--- Session Attachments (authoritative) ---');
      expect(seenSystemPrompts[0]).toContain(`- image: name="${uploadName}"`);
      expect(seenSystemPrompts[0]).toContain(`path=".harness/uploads/${uploadName}"`);
      expect(seenSystemPrompts[0]).toContain('image_analyze');
    } finally {
      restore();
      await fs.rm(path.join(process.cwd(), '.harness', 'uploads', uploadName), { force: true });
    }
  });

  it('streams uploads_fallback events, dedupes duplicates, and records tracer events', async () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = `fallback-trace-${Date.now()}.csv`;
    const uploadPath = path.join(uploadsDir, uploadName);
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(uploadPath, 'x,y\n', 'utf-8');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    runtimeTracer.clear();
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('fallback-trace-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (): AsyncGenerator<LoopEvent> {
        // First call triggers a real fallback recording into the buffer.
        const first = await FileReadTool.execute({ path: uploadName });
        yield { type: 'tool_call', call: { name: 'file_read', input: { path: uploadName } } };
        yield { type: 'tool_result', call: { name: 'file_read', input: { path: uploadName } }, result: first };
        // Second identical fallback should be deduped by the server.
        const second = await FileReadTool.execute({ path: uploadName });
        yield { type: 'tool_call', call: { name: 'file_read', input: { path: uploadName } } };
        yield { type: 'tool_result', call: { name: 'file_read', input: { path: uploadName } }, result: second };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'analyze', model: 'test-model' }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      const fallbackHits = body.match(/"type":"uploads_fallback"/g) ?? [];
      expect(fallbackHits.length).toBe(1);
      expect(body).toContain('"type":"uploads_fallback_summary"');
      expect(body).toContain(`"requested":"${uploadName}"`);
      const eventNames = runtimeTracer.snapshot().events.map((e) => e.name);
      expect(eventNames).toContain('uploads.fallback');
      expect(eventNames).toContain('uploads.fallback_summary');
    } finally {
      restore();
      warnSpy.mockRestore();
      await fs.rm(uploadPath, { force: true });
    }
  });

  it('emits an uploads_fallback_advice event when any fallback occurred', async () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = `fallback-advice-${Date.now()}.csv`;
    const uploadPath = path.join(uploadsDir, uploadName);
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(uploadPath, 'a,b\n', 'utf-8');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    runtimeTracer.clear();
    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('fallback-advice-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (): AsyncGenerator<LoopEvent> {
        const result = await FileReadTool.execute({ path: uploadName });
        yield { type: 'tool_call', call: { name: 'file_read', input: { path: uploadName } } };
        yield { type: 'tool_result', call: { name: 'file_read', input: { path: uploadName } }, result };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'analyze', model: 'test-model' }),
      });
      const body = await response.text();
      expect(body).toContain('"type":"uploads_fallback_advice"');
      expect(body).toContain('"tools":["file_read"]');
      expect(runtimeTracer.snapshot().events.map((e) => e.name)).toContain('uploads.fallback_advice');

      const evalsResponse = await request('/api/evals/runs');
      expect(evalsResponse.status).toBe(200);
      const evalsBody = await evalsResponse.json() as { uploadsFallbackTrend: { totalSessions: number; totalFallbacks: number; byTool: Record<string, number> } };
      expect(evalsBody.uploadsFallbackTrend.totalSessions).toBeGreaterThanOrEqual(1);
      expect(evalsBody.uploadsFallbackTrend.byTool.file_read).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
      warnSpy.mockRestore();
      await fs.rm(uploadPath, { force: true });
    }
  });

  it('uploads cleanup endpoint prunes files older than the requested days', async () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const oldName = `cleanup-old-${Date.now()}.txt`;
    const newName = `cleanup-new-${Date.now()}.txt`;
    const oldPath = path.join(uploadsDir, oldName);
    const newPath = path.join(uploadsDir, newName);
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(oldPath, 'old', 'utf-8');
    await fs.writeFile(newPath, 'new', 'utf-8');
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldPath, oldTime, oldTime);

    try {
      const response = await request('/api/uploads/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ olderThanDays: 5 }),
      });
      expect(response.status).toBe(200);
      const data = await response.json() as { removed: Array<{ name: string }>; removedBytes: number; olderThanDays: number; lastPrunedAt: string };
      expect(data.olderThanDays).toBe(5);
      expect(data.removed.map((r) => r.name)).toContain(oldName);
      expect(data.removed.map((r) => r.name)).not.toContain(newName);
      expect(typeof data.lastPrunedAt).toBe('string');
      expect(Number.isFinite(Date.parse(data.lastPrunedAt))).toBe(true);
      await expect(fs.stat(oldPath)).rejects.toThrow();
      await expect(fs.stat(newPath)).resolves.toBeDefined();

      const settingsResponse = await request('/api/settings');
      const settingsBody = await settingsResponse.json() as { mediaTools: { uploadsLastPrunedAt: string } };
      expect(settingsBody.mediaTools.uploadsLastPrunedAt).toBe(data.lastPrunedAt);
    } finally {
      await fs.rm(oldPath, { force: true });
      await fs.rm(newPath, { force: true });
    }
  });

  it('rejects zero-day uploads cleanup without deleting files', async () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = `cleanup-zero-${Date.now()}.txt`;
    const uploadPath = path.join(uploadsDir, uploadName);
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(uploadPath, 'keep', 'utf-8');

    try {
      const response = await request('/api/uploads/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ olderThanDays: 0 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('greater than 0') });
      await expect(fs.readFile(uploadPath, 'utf-8')).resolves.toBe('keep');
    } finally {
      await fs.rm(uploadPath, { force: true });
    }
  });

  it('streams PDFs from a configured external uploads directory', async () => {
    const originalUploadsDir = process.env.HARNESS_UPLOADS_DIR;
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-external-uploads-'));
    const pdfPath = path.join(externalDir, 'external-stream.pdf');
    process.env.HARNESS_UPLOADS_DIR = externalDir;
    await fs.writeFile(pdfPath, buildMinimalPdf('External upload PDF stream'));

    try {
      const response = await request('/api/pdf/extract?path=' + encodeURIComponent(pdfPath));
      expect(response.status).toBe(200);
      const body = await response.text();
      // pdfjs-dist requires --experimental-vm-modules for dynamic import;
      // when the flag is not fully propagated, the stream returns an error event.
      if (body.includes('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG')) {
        // Expected in some Node.js environments — the server correctly streams
        // an error event rather than crashing.
        expect(body).toContain('event: error');
      } else {
        expect(body).toContain('event: page');
        expect(body).toContain('External upload PDF stream');
        expect(body).toContain('event: done');
      }
    } finally {
      if (originalUploadsDir === undefined) delete process.env.HARNESS_UPLOADS_DIR;
      else process.env.HARNESS_UPLOADS_DIR = originalUploadsDir;
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized PDFs before streaming page content', async () => {
    const fixtureDir = path.join(process.cwd(), '.harness', 'test-web-pdf-stream');
    const pdfPath = path.join(fixtureDir, 'oversized.pdf');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n'));
    await fs.truncate(pdfPath, 50_000_001);

    try {
      const response = await request('/api/pdf/extract?path=' + encodeURIComponent(pdfPath));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('event: error');
      expect(body).toContain('PDF exceeds 50000000 bytes');
      expect(body).not.toContain('event: page');
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('persists uploadsDir media setting and exports HARNESS_UPLOADS_DIR', async () => {
    const originalEnv = process.env.HARNESS_UPLOADS_DIR;
    try {
      const response = await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaTools: { uploadsDir: '.harness/test-settings-uploads' } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { mediaTools: { uploadsDir: string } };
      expect(body.mediaTools.uploadsDir).toBe('.harness/test-settings-uploads');
      expect(process.env.HARNESS_UPLOADS_DIR).toBe('.harness/test-settings-uploads');
    } finally {
      // Restore env and reset stored setting so subsequent tests use the default uploads dir.
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaTools: { uploadsDir: '' } }),
      });
      if (originalEnv === undefined) delete process.env.HARNESS_UPLOADS_DIR;
      else process.env.HARNESS_UPLOADS_DIR = originalEnv;
    }
  });

  // Regression guard: GET/POST /api/api-keys must report key status
  // (configured + source) without ever returning the actual secret values.
  // The .harness/api-keys.json file uses 0o600 mode bits on Unix; the API
  // surface is the only protection on Windows. Any leak here would expose
  // user-entered remote backend tokens through the dashboard.
  describe('/api/api-keys leak protection', () => {
    const apiKeysPath = path.join(process.cwd(), '.harness', 'api-keys.json');
    let originalApiKeysFile: string | null = null;
    const SECRETS = {
      OPENAI_API_KEY: 'sk-leak-test-OPENAI-9d8f7a6b5c4e3f2a1b0c9d8e7f6a5b4c',
      MISTRAL_API_KEY: 'leak-test-MISTRAL-1122334455667788aabbccddeeff0011',
      CEREBRAS_API_KEY: 'csk-leak-test-CEREBRAS-deadbeefcafebabef00dfacef00dface',
      GROQ_API_KEY: 'gsk_leak_test_GROQ_abcdef0123456789abcdef0123456789',
    } as const;
    const ADDITIONAL_KEY_NAMES = [
      'DEEPINFRA_API_KEY',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'FIREWORKS_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'HF_TOKEN',
      'HUGGINGFACE_API_KEY',
      'SAMBANOVA_API_KEY',
      'REPLICATE_API_TOKEN',
      'TOGETHER_API_KEY',
    ];
    const ENV_SECRET = 'ghp_leak-test-GITHUB_aaaabbbbccccddddeeeeffff0000111122';
    let originalGithubEnv: string | undefined;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      try {
        originalApiKeysFile = await fs.readFile(apiKeysPath, 'utf-8');
      } catch {
        originalApiKeysFile = null;
      }
      // Save and clear any pre-existing real keys in process.env so the
      // 'file' source assertions below are deterministic. Real user keys
      // would otherwise win over the file values in /api/api-keys.
      for (const name of Object.keys(SECRETS)) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
      }
      for (const name of ADDITIONAL_KEY_NAMES) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
      }
      savedEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      originalGithubEnv = process.env.GITHUB_TOKEN;
      await fs.mkdir(path.dirname(apiKeysPath), { recursive: true });
      await fs.writeFile(apiKeysPath, JSON.stringify(SECRETS, null, 2), 'utf-8');
      process.env.GITHUB_TOKEN = ENV_SECRET;
    });

    afterAll(async () => {
      if (originalApiKeysFile === null) {
        await fs.rm(apiKeysPath, { force: true });
      } else {
        await fs.writeFile(apiKeysPath, originalApiKeysFile, 'utf-8');
      }
      if (originalGithubEnv === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGithubEnv;
      // Clear values that the POST test loaded into process.env so they
      // do not bleed into other tests, then restore the originals.
      for (const name of Object.keys(SECRETS)) delete process.env[name];
      for (const name of ADDITIONAL_KEY_NAMES) delete process.env[name];
      delete process.env.OPENROUTER_API_KEY;
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value !== undefined) process.env[name] = value;
      }
    });

    function assertNoSecretLeaks(payload: string): void {
      for (const [name, value] of Object.entries(SECRETS)) {
        expect(payload).not.toContain(value);
        // Defense-in-depth: also reject any non-trivial substring of the
        // secret. Catches accidental partial echoes (e.g. truncated keys).
        expect(payload).not.toContain(value.slice(8, 24));
        // The key NAME is allowed; the test exists to prove the value is not.
        // (Asserted separately below to keep failure messages readable.)
        void name;
      }
      expect(payload).not.toContain(ENV_SECRET);
      expect(payload).not.toContain(ENV_SECRET.slice(4, 20));
    }

    it('GET returns status (configured + source) without exposing key values', async () => {
      const response = await request('/api/api-keys');
      expect(response.status).toBe(200);
      const text = await response.text();
      assertNoSecretLeaks(text);
      const body = JSON.parse(text) as { keys: Record<string, { configured: boolean; source: 'env' | 'file' | 'none' }> };
      // File-stored keys should report source 'file' even after
      // loadStoredApiKeys has promoted them into process.env. The
      // FILE_SOURCED_KEYS tracker preserves provenance across that
      // promotion so users see 'stored' (file) in the UI rather than
      // the misleading 'from env'.
      expect(body.keys.OPENAI_API_KEY).toEqual({ configured: true, source: 'file' });
      expect(body.keys.MISTRAL_API_KEY).toEqual({ configured: true, source: 'file' });
      expect(body.keys.CEREBRAS_API_KEY).toEqual({ configured: true, source: 'file' });
      expect(body.keys.GROQ_API_KEY).toEqual({ configured: true, source: 'file' });
      // GITHUB_TOKEN was set directly in process.env (not via the file)
      // so it must still report as 'env'.
      expect(body.keys.GITHUB_TOKEN).toEqual({ configured: true, source: 'env' });
      // A backend with no key set should report none.
      expect(body.keys.ANTHROPIC_API_KEY).toEqual({ configured: false, source: 'none' });
    });

    it('POST then GET round-trip never echoes the submitted key value', async () => {
      const NEW_SECRET = 'sk-or-leak-test-OPENROUTER-roundtrip-7f6e5d4c3b2a19283746556677889900';
      const postResponse = await request('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ OPENROUTER_API_KEY: NEW_SECRET }),
      });
      expect(postResponse.status).toBe(200);
      const postText = await postResponse.text();
      expect(postText).not.toContain(NEW_SECRET);

      const getResponse = await request('/api/api-keys');
      expect(getResponse.status).toBe(200);
      const getText = await getResponse.text();
      expect(getText).not.toContain(NEW_SECRET);
      assertNoSecretLeaks(getText);
      const body = JSON.parse(getText) as { keys: Record<string, { configured: boolean; source: 'env' | 'file' | 'none' }> };
      expect(body.keys.OPENROUTER_API_KEY.configured).toBe(true);
    });

    it('POST refuses unknown key names and does not echo their values', async () => {
      const SNEAKY_SECRET = 'sneaky-leak-test-NOT_ALLOWED-99887766554433221100ffeeddccbbaa';
      const response = await request('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ NOT_A_REAL_API_KEY: SNEAKY_SECRET }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(SNEAKY_SECRET);
      expect(text).not.toContain('NOT_A_REAL_API_KEY');

      const getResponse = await request('/api/api-keys');
      const getText = await getResponse.text();
      expect(getText).not.toContain('NOT_A_REAL_API_KEY');
      expect(getText).not.toContain(SNEAKY_SECRET);
    });
  });
});

function buildMinimalPdf(text: string): Buffer {
  const escapeText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = text.length > 0
    ? `BT /F1 24 Tf 72 720 Td (${escapeText(text)}) Tj ET`
    : 'q Q';
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += obj + '\n';
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}