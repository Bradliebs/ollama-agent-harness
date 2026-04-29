import type { Server } from 'http';
import * as fs from 'fs/promises';
import http from 'http';
import * as path from 'path';
import { app, setWebRuntimeOverrides } from './server';
import { runtimeTracer } from '../core/tracing';
import { SessionStorage } from '../persistence/sessionStorage';
import { appendLearningCandidate, extractLearningCandidate } from '../learning/sessionLearning';
import { appendSubagentRoutingMetric } from '../agents/subagent';
import type { LoopEvent, SessionEvent } from '../types';

jest.setTimeout(30_000);

describe('web server API validation', () => {
  let server: Server;
  let baseUrl: string;
  let originalSettings: string | null = null;
  let originalValidationProfiles: string | null = null;
  const settingsPath = path.join(process.cwd(), '.harness', 'settings.json');
  const validationProfilesPath = path.join(process.cwd(), '.harness', 'output-validation-profiles.json');

  beforeAll(async () => {
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
    const response = await request('/api/about');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      assetName: expect.stringContaining('ollama-agent-harness-v'),
      manifestName: expect.stringContaining('.zip.sha256.json'),
      manifestUrl: expect.stringContaining('/download/v'),
      releaseUrl: expect.stringContaining('/releases/tag/v'),
    });
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
        body: JSON.stringify({ message: 'hello', model: 'test-model' }),
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
});