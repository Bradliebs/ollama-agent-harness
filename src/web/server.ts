import express from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as crypto from 'crypto';
import { Ollama } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { setSkillsDir } from '../tools/skillTools';
import { PermissionEngine } from '../permissions/engine';
import { PermissionPromptBroker } from '../permissions/promptBroker';
import { SessionStorage } from '../persistence/sessionStorage';
import { forkSession, resumeSession } from '../persistence/resume';
import { buildMemoryPalace, getSemanticMemoryContext, getSemanticMemoryEntry, rebuildSemanticMemory, searchSemanticMemory } from '../persistence/semanticMemory';
import { assembleSystemContext } from '../context/assembly';
import { HookPipeline } from '../extensibility/hookPipeline';
import { loadSkillsDir } from '../extensibility/skillLoader';
import { RateLimiter } from '../core/rateLimiter';
import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { OUTPUT_VALIDATION_PROFILES, OUTPUT_VALIDATION_PROFILE_TEMPLATES, normalizeCustomOutputValidationProfiles, parseOutputValidationProfile, validateCustomOutputValidationProfiles, validateOutput, type CustomOutputValidationProfile, type OutputValidationProfile } from '../core/outputValidation';
import { startNewSession, onSessionEnd, getEvolvedPrompt } from '../learning/engine';
import { appendEvalTraceExample, createEvalTraceExample, createOutputValidationTrendExport, createReplayEvalExample, deleteEvalTraceExample, listEvalTraceExamples, listEvalTraceRuns, readEvalTraceDataset, recordOutputValidationEvalRun, runEvalTraceDataset, summarizeEvalTraceRuns, summarizeOutputValidationRuns, updateEvalTraceExampleTags } from '../learning/evalTrace';
import { appendLearningCandidate, extractLearningCandidate, getLearningCandidateProvenance, listReviewedLearningCandidates, reviewLearningCandidate } from '../learning/sessionLearning';
import { listSubagentRoutingMetrics } from '../agents/subagent';
import { calibrateModelRoutingPolicy, summarizeRoutingMetrics } from '../agents/modelRouting';
import { checkSetupHealth } from '../setup/health';
import type { ModelRoutingPolicy } from '../agents/modelRouting';
import type { LoopConfig, LoopEvent, PermissionMode, Tool } from '../types';
import type { Message } from 'ollama';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'ui')));

const PROJECT_DIR = process.cwd();
const LOCAL_HOST = process.env.HOST ?? '127.0.0.1';
const UPLOADS_DIR = path.join(PROJECT_DIR, '.harness', 'uploads');
const HISTORY_DIR = path.join(PROJECT_DIR, '.harness', 'chat-history');
const SKILLS_DIR = path.join(PROJECT_DIR, '.harness', 'skills');
const TRACES_DIR = path.join(PROJECT_DIR, '.harness', 'traces');
const SETTINGS_PATH = path.join(PROJECT_DIR, '.harness', 'settings.json');
const OUTPUT_VALIDATION_PROFILES_PATH = path.join(PROJECT_DIR, '.harness', 'output-validation-profiles.json');
const RELEASE_PROVENANCE_PATH = path.join(PROJECT_DIR, 'release-provenance.json');
const ALLOWED_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'dontAsk'];
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

type QueryLoopRunner = (config: LoopConfig, deps: QueryLoopDeps, initialMessages: Message[]) => AsyncGenerator<LoopEvent>;

interface WebSettings {
  model: string;
  permissionMode: PermissionMode;
  ollamaHost: string;
  systemPrompt: string;
  summarizerModel: string;
  contextMaxTokens: number;
  context: { configuredMaxTokens: number; detectedMaxTokens: number | null; effectiveMaxTokens: number };
  temperature: number;
  topP: number;
  modelRouting: ModelRoutingPolicy;
  mediaTools: MediaToolSettings;
  outputValidation: OutputValidationSettings;
  outputValidationProfiles: Array<{ profile: string; label: string; description: string }>;
  customOutputValidationProfiles: CustomOutputValidationProfile[];
  walkthrough: WalkthroughSettings;
}

interface MediaToolSettings {
  visionModel: string;
  audioTranscribeCommand: string;
}

interface OutputValidationSettings {
  enabled: boolean;
  profile: OutputValidationProfile;
}

interface WalkthroughSettings {
  completed: string[];
}

interface WebRuntimeDeps {
  createClient(model: string, host: string, numCtx?: number): OllamaClient;
  getModelContextWindow(model: string, host: string): Promise<number | null>;
  getTools(): Tool[];
  createPermissionEngine(mode: PermissionMode): PermissionEngine;
  createSession(projectDir: string, model: string): SessionStorage;
  startNewSession(): void;
  getEvolvedPrompt(basePrompt: string): Promise<string>;
  assembleSystemContext(input: { systemPrompt: string; projectDir: string; skillsDir: string }): Promise<string>;
  runQueryLoop: QueryLoopRunner;
  onSessionEnd(): Promise<{ reflection: { insights: string[] }; newPatterns: unknown[] }>;
  rebuildSemanticMemory(projectDir: string): Promise<unknown[]>;
}

// --- State ---
let currentModel = '';
let permissionMode: PermissionMode = 'default';
let ollamaHost = 'http://localhost:11434';
let systemPromptOverride = '';
let summarizerModel = '';
const DEFAULT_CONTEXT_MAX_TOKENS = 8192;
let contextMaxTokens = DEFAULT_CONTEXT_MAX_TOKENS;
let detectedContextMaxTokens: number | null = null;
let temperature = 0.7;
let topP = 0.9;
let modelRouting: ModelRoutingPolicy = {};
let mediaTools: MediaToolSettings = {
  visionModel: process.env.HARNESS_VISION_MODEL ?? '',
  audioTranscribeCommand: process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND ?? '',
};
let outputValidation: OutputValidationSettings = { enabled: false, profile: 'oracle-prime' };
let customOutputValidationProfiles: CustomOutputValidationProfile[] = [];
let walkthrough: WalkthroughSettings = { completed: [] };
let settingsLoaded = false;
const rateLimiter = new RateLimiter(10, 2);
const hookPipeline = new HookPipeline();
const permissionPrompts = new PermissionPromptBroker();
const defaultWebRuntime: WebRuntimeDeps = {
  createClient: (model, host, numCtx) => new OllamaClient({ model, host, numCtx }),
  getModelContextWindow: (model, host) => new OllamaClient({ model, host }).getContextWindow(),
  getTools: getBuiltinTools,
  createPermissionEngine: (mode) => new PermissionEngine([], mode),
  createSession: (projectDir, model) => new SessionStorage(projectDir, model),
  startNewSession,
  getEvolvedPrompt,
  assembleSystemContext,
  runQueryLoop: queryLoop,
  onSessionEnd,
  rebuildSemanticMemory,
};
let webRuntime: WebRuntimeDeps = defaultWebRuntime;

// Initialize skills directory for SkillTool
setSkillsDir(SKILLS_DIR);

// --- API Routes ---

app.get('/api/about', async (_req, res) => {
  try {
    res.json(await getAboutInfo());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/about/verify', async (_req, res) => {
  try {
    res.json(await getReleaseVerification());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// List available models from Ollama
app.get('/api/models', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    const ollama = new Ollama({ host: ollamaHost });
    const response = await ollama.list();
    const models = response.models.map((m) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
      family: (m.details as unknown as Record<string, unknown>)?.family ?? '',
      parameterSize: (m.details as unknown as Record<string, unknown>)?.parameter_size ?? '',
      capabilities: inferModelCapabilities(m.name, m.details as unknown as Record<string, unknown>),
    }));
    res.json({ models });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(503).json({ error: `Cannot connect to Ollama: ${msg}` });
  }
});

// Get/set current settings
app.get('/api/settings', async (_req, res) => {
  await ensureSettingsLoaded();
  res.json(getCurrentSettings());
});

app.post('/api/settings', async (req, res) => {
  await ensureSettingsLoaded();
  if (req.body.model !== undefined) currentModel = sanitizeModelName(req.body.model);
  if (req.body.permissionMode !== undefined) {
    if (!ALLOWED_PERMISSION_MODES.includes(req.body.permissionMode)) {
      res.status(400).json({ error: 'Invalid permission mode.' });
      return;
    }
    permissionMode = req.body.permissionMode;
  }
  if (req.body.ollamaHost !== undefined) {
    const parsedHost = parseHttpUrl(req.body.ollamaHost);
    if (!parsedHost) { res.status(400).json({ error: 'Invalid Ollama host.' }); return; }
    ollamaHost = parsedHost;
  }
  if (req.body.systemPrompt !== undefined) systemPromptOverride = String(req.body.systemPrompt).slice(0, 20_000);
  if (req.body.summarizerModel !== undefined) summarizerModel = sanitizeModelName(req.body.summarizerModel);
  if (req.body.modelRouting !== undefined) modelRouting = sanitizeModelRoutingPolicy(req.body.modelRouting);
  if (req.body.mediaTools !== undefined) {
    mediaTools = sanitizeMediaToolSettings(req.body.mediaTools);
    applyMediaToolEnvironment(mediaTools);
  }
  if (req.body.outputValidation !== undefined) outputValidation = sanitizeOutputValidationSettings(req.body.outputValidation);
  if (req.body.walkthrough !== undefined) walkthrough = sanitizeWalkthroughSettings(req.body.walkthrough);
  if (req.body.contextMaxTokens !== undefined) contextMaxTokens = clampNumber(req.body.contextMaxTokens, 1024, 200_000, DEFAULT_CONTEXT_MAX_TOKENS);
  if (req.body.temperature !== undefined) temperature = clampNumber(req.body.temperature, 0, 2, 0.7);
  if (req.body.topP !== undefined) topP = clampNumber(req.body.topP, 0, 1, 0.9);
  await saveSettingsToDisk();
  logger.info('Settings', 'Updated', { model: currentModel, permissionMode, temperature, topP });
  res.json(getCurrentSettings());
});

app.get('/api/output-validation/profiles', async (_req, res) => {
  await ensureSettingsLoaded();
  res.json({ profiles: getOutputValidationProfiles(), customProfiles: customOutputValidationProfiles, path: '.harness/output-validation-profiles.json' });
});

app.get('/api/output-validation/templates', async (_req, res) => {
  res.json({ templates: OUTPUT_VALIDATION_PROFILE_TEMPLATES });
});

app.post('/api/output-validation/templates/install', async (req, res) => {
  await ensureSettingsLoaded();
  const requestedProfile = String(req.body?.profile ?? '').trim();
  const template = OUTPUT_VALIDATION_PROFILE_TEMPLATES.find((candidate) => candidate.profile === requestedProfile);
  if (!template) {
    res.status(404).json({ error: 'Unknown output validation template.' });
    return;
  }
  customOutputValidationProfiles = customOutputValidationProfiles.filter((profile) => profile.profile !== template.profile).concat(cloneTemplate(template));
  outputValidation = sanitizeOutputValidationSettings({ ...outputValidation, profile: template.profile });
  await saveCustomOutputValidationProfiles();
  await saveSettingsToDisk();
  res.json({ installed: template.profile, profiles: getOutputValidationProfiles(), customProfiles: customOutputValidationProfiles, path: '.harness/output-validation-profiles.json' });
});

app.post('/api/output-validation/preview', async (req, res) => {
  await ensureSettingsLoaded();
  const content = String(req.body?.content ?? '').slice(0, 200_000);
  const profile = parseOutputValidationProfile(req.body?.profile, customOutputValidationProfiles) ?? outputValidation.profile;
  res.json({ validation: validateOutput(content, profile, customOutputValidationProfiles) });
});

app.post('/api/output-validation/profiles', async (req, res) => {
  await ensureSettingsLoaded();
  const validation = validateCustomOutputValidationProfiles(req.body.profiles ?? req.body);
  if (validation.errors.length > 0) {
    res.status(400).json({ error: 'Custom profile schema validation failed.', errors: validation.errors });
    return;
  }
  const profiles = validation.profiles;
  customOutputValidationProfiles = profiles;
  outputValidation = sanitizeOutputValidationSettings(outputValidation);
  await saveCustomOutputValidationProfiles();
  res.json({ profiles: getOutputValidationProfiles(), customProfiles: customOutputValidationProfiles, path: '.harness/output-validation-profiles.json' });
});

app.get('/api/setup/health', async (req, res) => {
  await ensureSettingsLoaded();
  const requestedHost = typeof req.query.ollamaHost === 'string' && req.query.ollamaHost.trim()
    ? req.query.ollamaHost
    : ollamaHost;
  const parsedHost = parseHttpUrl(requestedHost);
  if (!parsedHost) {
    res.status(400).json({ error: 'Invalid Ollama host.' });
    return;
  }
  const requestedVisionModel = typeof req.query.visionModel === 'string'
    ? sanitizeModelName(req.query.visionModel)
    : mediaTools.visionModel;
  const requestedAudioCommand = typeof req.query.audioTranscribeCommand === 'string'
    ? String(req.query.audioTranscribeCommand).trim()
    : mediaTools.audioTranscribeCommand;
  const requestedAudioSamplePath = typeof req.query.audioSamplePath === 'string'
    ? String(req.query.audioSamplePath).trim()
    : '';
  res.json(await checkSetupHealth({
    host: parsedHost,
    visionModel: requestedVisionModel,
    audioTranscribeCommand: requestedAudioCommand,
    audioSamplePath: requestedAudioSamplePath || undefined,
  }));
});

app.get('/api/traces', (_req, res) => {
  res.json(runtimeTracer.snapshot());
});

app.delete('/api/traces', (_req, res) => {
  runtimeTracer.clear();
  res.json({ ok: true });
});

app.get('/api/traces/exports', async (_req, res) => {
  try {
    await fs.mkdir(TRACES_DIR, { recursive: true });
    const files = await fs.readdir(TRACES_DIR, { withFileTypes: true });
    const exports = [];
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
      const stat = await fs.stat(path.join(TRACES_DIR, file.name));
      exports.push({ id: file.name.replace(/\.json$/, ''), name: file.name, size: stat.size, createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString() });
    }
    exports.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    res.json({ exports });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/traces/exports', async (_req, res) => {
  try {
    await fs.mkdir(TRACES_DIR, { recursive: true });
    const snapshot = runtimeTracer.snapshot();
    const id = `trace-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const filePath = path.join(TRACES_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify({ id, exportedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf-8');
    res.json({ id, path: filePath, spans: snapshot.spans.length, events: snapshot.events.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/traces/exports/:id', async (req, res) => {
  const exportId = safeLocalId(req.params.id);
  if (!exportId) { res.status(400).json({ error: 'Invalid trace export id.' }); return; }
  try {
    const raw = await fs.readFile(path.join(TRACES_DIR, `${exportId}.json`), 'utf-8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'Trace export not found.' });
  }
});

app.get('/api/evals/trace-examples', async (_req, res) => {
  try {
    const examples = await listEvalTraceExamples(PROJECT_DIR);
    res.json({ examples });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/evals/trace-examples/download', async (_req, res) => {
  try {
    const raw = await readEvalTraceDataset(PROJECT_DIR);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="trace-examples.jsonl"');
    res.send(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/evals/runs', async (_req, res) => {
  try {
    const runs = await listEvalTraceRuns(PROJECT_DIR);
    res.json({ runs, trend: summarizeEvalTraceRuns(runs), outputValidationTrend: summarizeOutputValidationRuns(runs) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/evals/trace-examples/run', async (req, res) => {
  try {
    const mode = req.body?.mode === 'live' || req.body?.mode === 'mock' ? req.body.mode : 'stored';
    const run = await runEvalTraceDataset(PROJECT_DIR, {
      replayAdapter: mode === 'stored' ? undefined : async (example) => {
        if (mode === 'mock') {
          return {
            actualResponse: req.body?.mockResponse?.toString() ?? example.actualResponse,
            actualTools: Array.isArray(req.body?.mockTools) ? req.body.mockTools.map(String) : example.actualTools,
          };
        }
        const activeModel = sanitizeModelName(req.body?.model ?? currentModel);
        if (!activeModel) return { actualResponse: '', actualTools: [] };
        const activeContextMaxTokens = await resolveContextMaxTokens(activeModel);
        const client = webRuntime.createClient(activeModel, ollamaHost, activeContextMaxTokens);
        const response = await client.chat([{ role: 'user' as const, content: example.prompt ?? example.task }]);
        const toolCalls = response.message.tool_calls?.map((call) => call.function.name) ?? [];
        return { actualResponse: response.message.content ?? '', actualTools: toolCalls };
      },
    });
    const runs = await listEvalTraceRuns(PROJECT_DIR);
    res.json({ run, trend: summarizeEvalTraceRuns(runs), mode });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.patch('/api/evals/trace-examples/:id/tags', async (req, res) => {
  const exampleId = safeEvalExampleId(req.params.id);
  if (!exampleId) { res.status(400).json({ error: 'Invalid eval example id.' }); return; }
  try {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : String(req.body?.tags ?? '').split(',');
    const example = await updateEvalTraceExampleTags(PROJECT_DIR, exampleId, tags);
    res.json({ example });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(404).json({ error: msg });
  }
});

app.delete('/api/evals/trace-examples/:id', async (req, res) => {
  const exampleId = safeEvalExampleId(req.params.id);
  if (!exampleId) { res.status(400).json({ error: 'Invalid eval example id.' }); return; }
  try {
    const deleted = await deleteEvalTraceExample(PROJECT_DIR, exampleId);
    if (!deleted) { res.status(404).json({ error: 'Eval trace example not found.' }); return; }
    res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/evals/trace-examples', async (req, res) => {
  try {
    const example = createEvalTraceExample(runtimeTracer.snapshot(), {
      task: req.body?.task?.toString() || 'web runtime trace',
      expectedBehavior: req.body?.expectedBehavior?.toString() || undefined,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : ['web', 'runtime'],
    });
    const filePath = await appendEvalTraceExample(PROJECT_DIR, example);
    res.json({ example, path: filePath });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/evals/replay-examples', async (req, res) => {
  try {
    const example = createReplayEvalExample({
      task: req.body?.task?.toString() || 'replay regression',
      prompt: req.body?.prompt?.toString() || '',
      expectedBehavior: req.body?.expectedBehavior?.toString() || undefined,
      expectedResponseIncludes: Array.isArray(req.body?.expectedResponseIncludes) ? req.body.expectedResponseIncludes.map(String) : [],
      expectedTools: Array.isArray(req.body?.expectedTools) ? req.body.expectedTools.map(String) : [],
      actualResponse: req.body?.actualResponse?.toString() || undefined,
      actualTools: Array.isArray(req.body?.actualTools) ? req.body.actualTools.map(String) : [],
      sourceTraceId: req.body?.sourceTraceId?.toString() || undefined,
      sourceSessionId: req.body?.sourceSessionId?.toString() || undefined,
      sourceContext: req.body?.sourceContext?.toString() || undefined,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : ['replay'],
    });
    const filePath = await appendEvalTraceExample(PROJECT_DIR, example);
    res.json({ example, path: filePath });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/runtime/storage', async (_req, res) => {
  try {
    res.json(await getRuntimeStorageSummary());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/runtime/cleanup', async (req, res) => {
  try {
    const cleaned: string[] = [];
    if (Boolean(req.body.traces)) {
      await fs.rm(TRACES_DIR, { recursive: true, force: true });
      cleaned.push('traces');
    }
    if (Boolean(req.body.semanticIndex)) {
      await fs.rm(path.join(PROJECT_DIR, '.harness', 'memory', 'semantic-index.json'), { force: true });
      cleaned.push('semanticIndex');
    }
    res.json({ cleaned, storage: await getRuntimeStorageSummary() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/permissions/pending', (_req, res) => {
  res.json({ prompts: permissionPrompts.list() });
});

app.post('/api/permissions/:id/resolve', (req, res) => {
  const promptId = safeLocalId(req.params.id);
  if (!promptId) { res.status(400).json({ error: 'Invalid permission prompt id.' }); return; }
  const allowed = Boolean(req.body.allowed);
  const resolved = permissionPrompts.resolve(promptId, allowed, req.body.reason?.toString());
  if (!resolved) { res.status(404).json({ error: 'Permission prompt not found.' }); return; }
  runtimeTracer.recordEvent('permission.prompt_resolved', { promptId, allowed });
  res.json({ ok: true });
});

// Chat endpoint — runs the agent loop and streams events as SSE
app.post('/api/chat', async (req, res) => {
  await ensureSettingsLoaded();
  const { message, model } = req.body;
  if (!message) { res.status(400).json({ error: 'message is required' }); return; }

  const activeModel = model || currentModel;
  if (!activeModel) { res.status(400).json({ error: 'No model selected.' }); return; }

  if (!rateLimiter.tryConsume()) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  const activeContextMaxTokens = await resolveContextMaxTokens(activeModel);
  const client = webRuntime.createClient(activeModel, ollamaHost, activeContextMaxTokens);
  const tools = webRuntime.getTools();
  const permissions = webRuntime.createPermissionEngine(permissionMode);
  const projectDir = PROJECT_DIR;

  // Start a new learning session for tracking
  webRuntime.startNewSession();

  const basePrompt = systemPromptOverride ||
    'You are a self-learning AI assistant with full web access and local tool use. IMPORTANT RULES:\n' +
    '1. When the user asks about something on the web (weather, news, docs, prices, etc.), ALWAYS use web_search to find it, then web_read to fetch the actual content. NEVER just suggest links — fetch the data yourself and show the results.\n' +
    '2. You can read files, write files, edit code, run commands, search files with grep, search the web, and read web pages.\n' +
    '3. When you notice a reusable pattern, create a skill. When you learn something important, use the remember tool.\n' +
    '4. Format responses in Markdown.\n' +
    '5. Be direct — do the work, don\'t ask the user to do it themselves.';

  // Use evolved prompt — layers in learned patterns and self-improvements
  const evolvedPrompt = await webRuntime.getEvolvedPrompt(basePrompt);
  const systemPrompt = await webRuntime.assembleSystemContext({ systemPrompt: withRoutingPolicy(evolvedPrompt), projectDir, skillsDir: SKILLS_DIR });

  const config: LoopConfig = {
    model: activeModel,
    systemPrompt,
    maxTurns: 25,
    abortSignal: abortController.signal,
    context: { maxTokens: activeContextMaxTokens, summarizerModel },
    outputValidation: { ...outputValidation, customProfiles: customOutputValidationProfiles },
  };
  const session = webRuntime.createSession(projectDir, activeModel);
  await session.initialize();

  const deps: QueryLoopDeps = {
    client,
    tools,
    permissionCheck: async (call) => {
      const result = permissions.evaluate(call);
      if (result.decision === 'allow') {
        return { allowed: true, reason: result.reason };
      }
      if (result.decision === 'deny') {
        return { allowed: false, reason: result.reason };
      }
      runtimeTracer.recordEvent('permission.prompt_created', { tool: call.name, reason: result.reason });
      return permissionPrompts.request(call, result.reason);
    },
    hooks: hookPipeline,
    session,
    summarizerClient: summarizerModel ? webRuntime.createClient(summarizerModel, ollamaHost, activeContextMaxTokens) : undefined,
    tracer: runtimeTracer,
  };

  const messages = [{ role: 'user' as const, content: message }];
  logger.info('Chat', `User: ${message.slice(0, 80)}`, { model: activeModel });

  try {
    for await (const event of webRuntime.runQueryLoop(config, deps, messages)) {
      if (event.type === 'output_validation') {
        await recordOutputValidationEvalRun(PROJECT_DIR, event.validation, message.slice(0, 120));
      }
      const data = JSON.stringify(event);
      res.write(`data: ${data}\n\n`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Chat', 'Loop error', { error: msg });
    res.write(`data: ${JSON.stringify({ type: 'error', message: msg, recoverable: false })}\n\n`);
  }

  // Auto-reflection: analyze this session's tool usage (runs silently, non-blocking)
  webRuntime.onSessionEnd().then(({ reflection, newPatterns }) => {
    if (reflection.insights.length > 0) {
      logger.info('Learning', `Session reflection: ${reflection.insights.join('; ')}`);
    }
    if (newPatterns.length > 0) {
      logger.info('Learning', `${newPatterns.length} patterns ready for skill promotion`);
    }
  }).catch(() => {});
  persistSessionLearning(session, projectDir).catch(() => {});
  webRuntime.rebuildSemanticMemory(projectDir).catch(() => {});

  res.write('data: [DONE]\n\n');
  res.end();
});

// --- API: Sessions, Recovery, Forking, Semantic Recall ---
app.get('/api/sessions', async (_req, res) => {
  try {
    const sessions = await SessionStorage.listSessions(PROJECT_DIR);
    res.json({ sessions });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/sessions/recover', async (_req, res) => {
  try {
    const sessions = await SessionStorage.listRecoverableSessions(PROJECT_DIR);
    res.json({ sessions });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const sessionId = safeLocalId(req.params.id);
    if (!sessionId) { res.status(400).json({ error: 'Invalid session id.' }); return; }
    const activeModel = currentModel || req.query.model?.toString() || 'unknown';
    const result = await resumeSession(PROJECT_DIR, sessionId, activeModel);
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/sessions/:id/fork', async (req, res) => {
  try {
    const sessionId = safeLocalId(req.params.id);
    if (!sessionId) { res.status(400).json({ error: 'Invalid session id.' }); return; }
    const activeModel = req.body.model || currentModel;
    if (!activeModel) { res.status(400).json({ error: 'No model selected.' }); return; }
    const result = await forkSession(PROJECT_DIR, sessionId, activeModel);
    res.json({ sessionId: result.newStorage.getSessionId(), messageCount: result.messages.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/memory/rebuild', async (_req, res) => {
  try {
    const entries = await rebuildSemanticMemory(PROJECT_DIR);
    res.json({ entries: entries.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/memory/search', async (req, res) => {
  try {
    const query = req.query.q?.toString() ?? '';
    const results = await searchSemanticMemory(PROJECT_DIR, query.slice(0, 500));
    res.json({ results });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/memory/entries/:id', async (req, res) => {
  const entryId = safeLocalId(req.params.id);
  if (!entryId) { res.status(400).json({ error: 'Invalid memory entry id.' }); return; }
  try {
    const entry = await getSemanticMemoryEntry(PROJECT_DIR, entryId);
    if (!entry) { res.status(404).json({ error: 'Memory entry not found.' }); return; }
    res.json({ entry });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/memory/entries/:id/context', async (req, res) => {
  const entryId = safeLocalId(req.params.id);
  if (!entryId) { res.status(400).json({ error: 'Invalid memory entry id.' }); return; }
  try {
    const context = await getSemanticMemoryContext(PROJECT_DIR, entryId, clampNumber(req.query.window, 1, 10, 3));
    if (!context) { res.status(404).json({ error: 'Memory entry not found.' }); return; }
    res.json(context);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/memory/palace', async (_req, res) => {
  try {
    const palace = await buildMemoryPalace(PROJECT_DIR);
    res.json(palace);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Pull a model from Ollama
app.post('/api/models/pull', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: 'model name is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  try {
    const ollama = new Ollama({ host: ollamaHost });
    const stream = await ollama.pull({ model: name, stream: true });
    for await (const progress of stream) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// --- API: Chat History ---
app.get('/api/history', async (_req, res) => {
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    const files = await fs.readdir(HISTORY_DIR);
    const chats = [];
    for (const f of files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, 50)) {
      try {
        const raw = await fs.readFile(path.join(HISTORY_DIR, f), 'utf-8');
        const data = JSON.parse(raw);
        chats.push({ id: f.replace('.json', ''), title: data.title ?? 'Untitled', date: data.date, messageCount: data.messages?.length ?? 0 });
      } catch { /* skip corrupt */ }
    }
    res.json({ chats });
  } catch { res.json({ chats: [] }); }
});

app.get('/api/history/:id', async (req, res) => {
  try {
    const chatId = safeLocalId(req.params.id);
    if (!chatId) { res.status(400).json({ error: 'Invalid chat id.' }); return; }
    const raw = await fs.readFile(path.join(HISTORY_DIR, `${chatId}.json`), 'utf-8');
    res.json(JSON.parse(raw));
  } catch { res.status(404).json({ error: 'Chat not found' }); }
});

app.post('/api/history', async (req, res) => {
  const { id, title, messages, date } = req.body;
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    const chatId = safeLocalId(id) || Date.now().toString(36);
    await fs.writeFile(path.join(HISTORY_DIR, `${chatId}.json`), JSON.stringify({ title, messages, date: date || new Date().toISOString() }, null, 2));
    res.json({ id: chatId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    const chatId = safeLocalId(req.params.id);
    if (!chatId) { res.status(400).json({ error: 'Invalid chat id.' }); return; }
    await fs.unlink(path.join(HISTORY_DIR, `${chatId}.json`));
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// --- API: Skills ---
app.get('/api/skills', async (_req, res) => {
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const skills = await loadSkillsDir(SKILLS_DIR);
    res.json({ skills: skills.map(s => ({ name: s.name, description: s.description, domain: s.domain, triggers: s.triggers, filePath: s.filePath })) });
  } catch { res.json({ skills: [] }); }
});

app.get('/api/skills/:name', async (req, res) => {
  try {
    const skillName = safeLocalId(req.params.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const skills = await loadSkillsDir(SKILLS_DIR);
    const skill = skills.find(s => s.name === skillName);
    if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
    res.json(skill);
  } catch { res.status(500).json({ error: 'Failed to load skill' }); }
});

app.delete('/api/skills/:name', async (req, res) => {
  try {
    const skillName = safeLocalId(req.params.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const skillDir = path.join(SKILLS_DIR, skillName);
    await fs.rm(skillDir, { recursive: true });
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Skill not found' }); }
});

// --- API: Agent Memory ---
app.get('/api/memory', async (_req, res) => {
  const memDir = path.join(PROJECT_DIR, '.harness', 'memory');
  const result: Record<string, string> = {};
  for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
    try {
      result[file.replace('.md', '')] = await fs.readFile(path.join(memDir, file), 'utf-8');
    } catch { /* not yet created */ }
  }
  res.json(result);
});

// --- API: Learning ---
app.get('/api/learning', async (_req, res) => {
  const learningDir = path.join(PROJECT_DIR, '.harness', 'learning');
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
  const subagentRouting = await listSubagentRoutingMetrics(PROJECT_DIR, 100);
  result.candidates = await listReviewedLearningCandidates(PROJECT_DIR);
  result.subagentRouting = subagentRouting;
  result.routingSummary = summarizeRoutingMetrics(subagentRouting);
  result.routingCalibration = calibrateModelRoutingPolicy(subagentRouting, modelRouting);
  const evalRuns = await listEvalTraceRuns(PROJECT_DIR);
  result.evalExamples = await listEvalTraceExamples(PROJECT_DIR);
  result.evalRuns = evalRuns;
  result.evalRunTrend = summarizeEvalTraceRuns(evalRuns);
  result.outputValidationTrend = summarizeOutputValidationRuns(evalRuns);
  try {
    const raw = await fs.readFile(path.join(learningDir, 'tool-usage.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    result.totalToolCalls = lines.length;
    // Tool usage breakdown
    const counts: Record<string, number> = {};
    for (const line of lines) { try { const e = JSON.parse(line); counts[e.tool] = (counts[e.tool] || 0) + 1; } catch {} }
    result.toolBreakdown = counts;
  } catch { result.totalToolCalls = 0; result.toolBreakdown = {}; }
  res.json(result);
});

app.get('/api/learning/routing', async (_req, res) => {
  try {
    const metrics = await listSubagentRoutingMetrics(PROJECT_DIR, 100);
    res.json({ metrics, summary: summarizeRoutingMetrics(metrics), calibration: calibrateModelRoutingPolicy(metrics, modelRouting) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/learning/output-validation-trends/download', async (_req, res) => {
  try {
    const runs = await listEvalTraceRuns(PROJECT_DIR, 1000);
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

app.post('/api/learning/routing/apply-calibration', async (_req, res) => {
  await ensureSettingsLoaded();
  try {
    const metrics = await listSubagentRoutingMetrics(PROJECT_DIR, 100);
    const calibration = calibrateModelRoutingPolicy(metrics, modelRouting);
    modelRouting = sanitizeModelRoutingPolicy({ ...modelRouting, ...calibration.suggestedPolicy });
    await saveSettingsToDisk();
    res.json({ settings: getCurrentSettings(), calibration });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/learning/candidates/review', async (req, res) => {
  const candidateId = String(req.body?.id ?? '').trim();
  const action = req.body?.action === 'promote' || req.body?.action === 'reject' ? req.body.action : null;
  if (!candidateId || !action) { res.status(400).json({ error: 'Candidate id and review action are required.' }); return; }
  try {
    const review = await reviewLearningCandidate(PROJECT_DIR, candidateId, action, req.body?.reason?.toString());
    const candidates = await listReviewedLearningCandidates(PROJECT_DIR);
    res.json({ review, candidates });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: msg });
  }
});

app.get('/api/learning/candidates/:id/provenance', async (req, res) => {
  const candidateId = safeEvalExampleId(req.params.id);
  if (!candidateId) { res.status(400).json({ error: 'Invalid learning candidate id.' }); return; }
  try {
    res.json(await getLearningCandidateProvenance(PROJECT_DIR, candidateId));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(404).json({ error: msg });
  }
});

// --- API: File Upload ---
app.post('/api/upload', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const filename = req.headers['x-filename'] as string;
  if (!filename) { res.status(400).json({ error: 'x-filename header required' }); return; }

  // Sanitize filename — strip path traversal
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe) { res.status(400).json({ error: 'Invalid filename' }); return; }

  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const dest = path.join(UPLOADS_DIR, safe);
    await fs.writeFile(dest, req.body);
    logger.info('Upload', `File saved: ${safe} (${req.body.length} bytes)`);
    const mimeType = req.headers['content-type']?.toString() || 'application/octet-stream';
    res.json({ path: dest, name: safe, size: req.body.length, mimeType, mediaKind: inferMediaKind(safe, mimeType) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

function inferMediaKind(fileName: string, mimeType: string): 'image' | 'audio' | 'text' | 'data' | 'other' {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lowerName)) return 'image';
  if (lowerMime.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|opus)$/.test(lowerName)) return 'audio';
  if (lowerMime.startsWith('text/') || /\.(txt|md|csv|json|log|ts|js|py|cs|rs|html|css)$/.test(lowerName)) return 'text';
  if (/\.(jsonl|xml|yaml|yml|parquet|sqlite|db)$/.test(lowerName)) return 'data';
  return 'other';
}

app.get('/api/uploads', async (_req, res) => {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const entries = await fs.readdir(UPLOADS_DIR, { withFileTypes: true });
    const files = [];
    for (const e of entries.filter(e => e.isFile())) {
      const stat = await fs.stat(path.join(UPLOADS_DIR, e.name));
      files.push({ name: e.name, path: path.join(UPLOADS_DIR, e.name), size: stat.size, modified: stat.mtime.toISOString() });
    }
    res.json({ files });
  } catch { res.json({ files: [] }); }
});

app.delete('/api/uploads/:name', async (req, res) => {
  const safe = safeLocalId(path.basename(req.params.name));
  if (!safe) { res.status(400).json({ error: 'Invalid upload name.' }); return; }
  try {
    await fs.unlink(path.join(UPLOADS_DIR, safe));
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// --- API: File Tree ---
app.get('/api/files', async (req, res) => {
  const dir = resolveProjectPath((req.query.path as string) || PROJECT_DIR);
  if (!dir) { res.status(400).json({ error: 'Path is outside the project directory.' }); return; }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: path.join(dir, e.name) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ items, cwd: dir });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: msg });
  }
});

// --- Start ---

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(preferred: number, maxAttempts: number = 20): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferred + i;
    if (await isPortAvailable(port)) return port;
  }
  return 0;
}

function openBrowser(url: string): void {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors */ });
}

function sanitizeModelName(value: unknown): string {
  return String(value ?? '').trim().slice(0, 120);
}

function inferModelCapabilities(name: string, details: Record<string, unknown> = {}): { text: boolean; image: boolean; audio: boolean; notes: string[] } {
  const haystack = `${name} ${Object.values(details).join(' ')}`.toLowerCase();
  const image = /llava|bakllava|moondream|vision|qwen\d*(?:\.\d+)?vl|qwen.*vl|minicpm-v|granite.*vision|gemma.*vision/.test(haystack);
  const audio = /whisper|audio|speech|wav2vec|parakeet|sensevoice/.test(haystack);
  const notes = [
    image ? 'Can likely reason over images when the chat path passes image data.' : 'Text chat model unless another modality is documented by the model.',
    audio ? 'Audio-related model detected; transcription or audio tooling may be needed before chat.' : '',
  ].filter(Boolean);
  return { text: true, image, audio, notes };
}

function parseHttpUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && SAFE_ID_PATTERN.test(id) ? id : null;
}

function safeEvalExampleId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && /^[a-zA-Z0-9:._-]+$/.test(id) ? id : null;
}

function resolveProjectPath(value: string): string | null {
  const resolved = path.resolve(value);
  const relative = path.relative(PROJECT_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function getCurrentSettings(): WebSettings {
  return {
    model: currentModel,
    permissionMode,
    ollamaHost,
    systemPrompt: systemPromptOverride,
    summarizerModel,
    contextMaxTokens,
    context: {
      configuredMaxTokens: contextMaxTokens,
      detectedMaxTokens: detectedContextMaxTokens,
      effectiveMaxTokens: Math.max(contextMaxTokens, detectedContextMaxTokens ?? 0),
    },
    temperature,
    topP,
    modelRouting,
    mediaTools,
    outputValidation,
    outputValidationProfiles: getOutputValidationProfiles(),
    customOutputValidationProfiles,
    walkthrough,
  };
}

async function resolveContextMaxTokens(model: string): Promise<number> {
  const configured = Number.isFinite(contextMaxTokens) ? contextMaxTokens : DEFAULT_CONTEXT_MAX_TOKENS;
  const detected = await webRuntime.getModelContextWindow(model, ollamaHost);
  detectedContextMaxTokens = detected;
  if (!detected || detected <= configured) return configured;
  contextMaxTokens = clampNumber(detected, 1024, 200_000, configured);
  await saveSettingsToDisk().catch(() => {});
  return contextMaxTokens;
}

async function ensureSettingsLoaded(): Promise<void> {
  if (settingsLoaded) return;
  settingsLoaded = true;
  await loadCustomOutputValidationProfiles();
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw) as Partial<WebSettings>;
    applyStoredSettings(settings);
  } catch {
    // Missing or malformed settings should not prevent the local UI from starting.
  }
}

function applyStoredSettings(settings: Partial<WebSettings>): void {
  if (settings.model !== undefined) currentModel = sanitizeModelName(settings.model);
  if (settings.permissionMode !== undefined && ALLOWED_PERMISSION_MODES.includes(settings.permissionMode)) permissionMode = settings.permissionMode;
  if (settings.ollamaHost !== undefined) {
    const parsedHost = parseHttpUrl(settings.ollamaHost);
    if (parsedHost) ollamaHost = parsedHost;
  }
  if (settings.systemPrompt !== undefined) systemPromptOverride = String(settings.systemPrompt).slice(0, 20_000);
  if (settings.summarizerModel !== undefined) summarizerModel = sanitizeModelName(settings.summarizerModel);
  if (settings.modelRouting !== undefined) modelRouting = sanitizeModelRoutingPolicy(settings.modelRouting);
  if (settings.mediaTools !== undefined) {
    mediaTools = sanitizeMediaToolSettings(settings.mediaTools);
    applyMediaToolEnvironment(mediaTools);
  }
  if (settings.outputValidation !== undefined) outputValidation = sanitizeOutputValidationSettings(settings.outputValidation);
  if (settings.walkthrough !== undefined) walkthrough = sanitizeWalkthroughSettings(settings.walkthrough);
  if (settings.contextMaxTokens !== undefined) contextMaxTokens = clampNumber(settings.contextMaxTokens, 1024, 200_000, DEFAULT_CONTEXT_MAX_TOKENS);
  if (settings.temperature !== undefined) temperature = clampNumber(settings.temperature, 0, 2, 0.7);
  if (settings.topP !== undefined) topP = clampNumber(settings.topP, 0, 1, 0.9);
}

function sanitizeModelRoutingPolicy(value: unknown): ModelRoutingPolicy {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const policy: ModelRoutingPolicy = {};
  if (source.smallModel !== undefined) policy.smallModel = sanitizeModelName(source.smallModel);
  if (source.defaultModel !== undefined) policy.defaultModel = sanitizeModelName(source.defaultModel);
  if (source.strongModel !== undefined) policy.strongModel = sanitizeModelName(source.strongModel);
  if (source.fallbackModel !== undefined) policy.fallbackModel = sanitizeModelName(source.fallbackModel);
  if (source.promptLengthEscalationThreshold !== undefined) policy.promptLengthEscalationThreshold = Math.floor(clampNumber(source.promptLengthEscalationThreshold, 1000, 200_000, 6000));
  if (source.failureEscalationThreshold !== undefined) policy.failureEscalationThreshold = Math.floor(clampNumber(source.failureEscalationThreshold, 1, 20, 2));
  if (source.confidenceEscalationThreshold !== undefined) policy.confidenceEscalationThreshold = clampNumber(source.confidenceEscalationThreshold, 0, 1, 0.45);
  return policy;
}

function sanitizeMediaToolSettings(value: unknown): MediaToolSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    visionModel: sanitizeModelName(source.visionModel).slice(0, 200),
    audioTranscribeCommand: String(source.audioTranscribeCommand ?? '').trim().slice(0, 5000),
  };
}

function sanitizeOutputValidationSettings(value: unknown): OutputValidationSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const profile = parseOutputValidationProfile(source.profile, customOutputValidationProfiles) ?? 'oracle-prime';
  return { enabled: source.enabled === true, profile };
}

function sanitizeWalkthroughSettings(value: unknown): WalkthroughSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const allowed = new Set(['setup', 'validation', 'learning', 'about']);
  const completed = Array.isArray(source.completed)
    ? Array.from(new Set(source.completed.map((item) => String(item)).filter((item) => allowed.has(item))))
    : [];
  return { completed };
}

function getOutputValidationProfiles(): WebSettings['outputValidationProfiles'] {
  return [...OUTPUT_VALIDATION_PROFILES, ...customOutputValidationProfiles.map(({ profile, label, description }) => ({ profile, label, description }))];
}

async function loadCustomOutputValidationProfiles(): Promise<void> {
  try {
    const raw = await fs.readFile(OUTPUT_VALIDATION_PROFILES_PATH, 'utf-8');
    customOutputValidationProfiles = normalizeCustomOutputValidationProfiles(JSON.parse(raw));
  } catch {
    customOutputValidationProfiles = [];
  }
}

async function saveCustomOutputValidationProfiles(): Promise<void> {
  await fs.mkdir(path.dirname(OUTPUT_VALIDATION_PROFILES_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_VALIDATION_PROFILES_PATH, JSON.stringify({ profiles: customOutputValidationProfiles }, null, 2), 'utf-8');
}

function cloneTemplate(template: CustomOutputValidationProfile): CustomOutputValidationProfile {
  return JSON.parse(JSON.stringify(template)) as CustomOutputValidationProfile;
}

function applyMediaToolEnvironment(settings: MediaToolSettings): void {
  if (settings.visionModel) process.env.HARNESS_VISION_MODEL = settings.visionModel;
  else delete process.env.HARNESS_VISION_MODEL;
  if (settings.audioTranscribeCommand) process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND = settings.audioTranscribeCommand;
  else delete process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
}

function withRoutingPolicy(prompt: string): string {
  const entries = Object.entries(modelRouting).filter(([, value]) => value !== undefined && value !== '');
  if (entries.length === 0) return prompt;
  return prompt + '\n\n--- Helper Model Routing Policy ---\n' + entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

async function persistSessionLearning(session: SessionStorage, projectDir: string): Promise<void> {
  const events = await session.readAll();
  const candidate = extractLearningCandidate(session.getSessionId(), events);
  await appendLearningCandidate(projectDir, candidate);
}

async function saveSettingsToDisk(): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const { outputValidationProfiles, customOutputValidationProfiles: profiles, ...settings } = getCurrentSettings();
  void outputValidationProfiles;
  void profiles;
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

async function getRuntimeStorageSummary(): Promise<{ traces: { count: number; bytes: number }; semanticIndex: { exists: boolean; bytes: number } }> {
  return {
    traces: await directoryJsonStats(TRACES_DIR),
    semanticIndex: await fileStats(path.join(PROJECT_DIR, '.harness', 'memory', 'semantic-index.json')),
  };
}

async function getAboutInfo(): Promise<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string }> {
  const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_DIR, 'package.json'), 'utf-8')) as { version?: string };
  const provenance = await readReleaseProvenance();
  const version = packageJson.version ?? provenance.version ?? 'unknown';
  return {
    version,
    commit: provenance.commit ?? process.env.GITHUB_SHA ?? '',
    assetName: provenance.assetName ?? `ollama-agent-harness-v${version}.zip`,
    assetSha256: provenance.assetSha256 ?? '',
    releaseUrl: provenance.releaseUrl ?? `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v${version}`,
    generatedAt: provenance.generatedAt ?? '',
  };
}

async function getReleaseVerification(): Promise<{ status: 'verified' | 'warning'; message: string; version: string; commit: string; assetName: string; releaseUrl: string; expectedSha256: string; localArchiveSha256: string; localArchivePath: string }> {
  const about = await getAboutInfo();
  const localArchivePath = path.join(PROJECT_DIR, 'release', about.assetName);
  const localArchiveSha256 = await sha256FileIfExists(localArchivePath);
  if (about.assetSha256 && localArchiveSha256) {
    const verified = about.assetSha256.toLowerCase() === localArchiveSha256.toLowerCase();
    return {
      status: verified ? 'verified' : 'warning',
      message: verified ? 'Local release archive matches the recorded SHA-256.' : 'Local release archive SHA-256 does not match the recorded release provenance.',
      version: about.version,
      commit: about.commit,
      assetName: about.assetName,
      releaseUrl: about.releaseUrl,
      expectedSha256: about.assetSha256,
      localArchiveSha256,
      localArchivePath: path.relative(PROJECT_DIR, localArchivePath),
    };
  }
  return {
    status: 'warning',
    message: about.assetSha256
      ? 'Recorded SHA-256 is available, but no local release archive was found to compare.'
      : 'This install has release provenance, but the release asset SHA-256 is only available on the GitHub release page.',
    version: about.version,
    commit: about.commit,
    assetName: about.assetName,
    releaseUrl: about.releaseUrl,
    expectedSha256: about.assetSha256,
    localArchiveSha256,
    localArchivePath: path.relative(PROJECT_DIR, localArchivePath),
  };
}

async function sha256FileIfExists(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

async function readReleaseProvenance(): Promise<Partial<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string }>> {
  try {
    return JSON.parse(await fs.readFile(RELEASE_PROVENANCE_PATH, 'utf-8')) as Partial<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string }>;
  } catch {
    return {};
  }
}

async function directoryJsonStats(dirPath: string): Promise<{ count: number; bytes: number }> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const stat = await fs.stat(path.join(dirPath, entry.name));
      count++;
      bytes += stat.size;
    }
    return { count, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

async function fileStats(filePath: string): Promise<{ exists: boolean; bytes: number }> {
  try {
    const stat = await fs.stat(filePath);
    return { exists: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

export async function startServer(): Promise<void> {
  await ensureSettingsLoaded();
  const preferred = parseInt(process.env.PORT ?? '3000', 10);
  const port = await findAvailablePort(preferred);

  app.listen(port, LOCAL_HOST, () => {
    const url = `http://${LOCAL_HOST}:${port}`;
    if (port !== preferred) {
      console.log(`\n  ⚠️  Port ${preferred} was in use — using ${port} instead.`);
    }
    console.log(`\n  🤖 Ollama Agent Harness`);
    console.log(`  ───────────────────────`);
    console.log(`  Open in your browser:  ${url}`);
    console.log(`  Ollama host:           ${ollamaHost}`);
    console.log(`\n  Press Ctrl+C to stop.\n`);

    if (process.env.NO_OPEN !== '1') {
      openBrowser(url);
    }
  });
}

export { app };

export function setWebRuntimeOverrides(overrides: Partial<WebRuntimeDeps>): () => void {
  webRuntime = { ...defaultWebRuntime, ...overrides };
  return () => { webRuntime = defaultWebRuntime; };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
