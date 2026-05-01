import express from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as crypto from 'crypto';
import { Ollama } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { createBuiltinToolRegistry } from '../tools/registry';
import { WorkflowRegistry } from '../workflows/workflowRegistry';
import { runCurator, runDeterministicPhase, readCuratorLog, readCuratorProposals, restoreSkill, type CuratorConfig } from '../curator/curator';
import { CuratorScheduler } from '../curator/scheduler';
import { listSkillUsage, recordSkillView, setSkillPinned } from '../extensibility/skillUsage';
import { drainUploadsFallbacks, getUploadsDir, resolveProjectReadPath } from '../tools/pathResolution';
import { iteratePdfPages, MAX_PDF_BYTES } from '../tools/pdfTool';
import { setSkillsDir } from '../tools/skillTools';
import { setRagRuntime } from '../tools/ragTools';
import { PermissionEngine } from '../permissions/engine';
import { PermissionPromptBroker } from '../permissions/promptBroker';
import { SessionStorage } from '../persistence/sessionStorage';
import { forkSession, resumeSession } from '../persistence/resume';
import { buildMemoryPalace, getSemanticMemoryContext, getSemanticMemoryEntry, rebuildSemanticMemory, searchSemanticMemory } from '../persistence/semanticMemory';
import * as snapshots from '../persistence/snapshots';
import * as ragIndex from '../persistence/ragIndex';
import { MCP_CATALOG } from '../extensibility/mcpCatalog';
import { assembleSystemContext, estimateTokenCount } from '../context/assembly';
import { HookPipeline } from '../extensibility/hookPipeline';
import { loadSkillsDir, scanSkillsDir } from '../extensibility/skillLoader';
import { discoverExtensionManifests } from '../extensibility/extensionManifest';
import { RateLimiter } from '../core/rateLimiter';
import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { OUTPUT_VALIDATION_PROFILES, OUTPUT_VALIDATION_PROFILE_TEMPLATES, describeOutputValidationProfileSuggestion, normalizeCustomOutputValidationProfiles, parseOutputValidationProfile, validateCustomOutputValidationProfiles, validateOutput, type CustomOutputValidationProfile, type OutputValidationProfile } from '../core/outputValidation';
import { startNewSession, onSessionEnd, getEvolvedPrompt } from '../learning/engine';
import { appendEvalTraceExample, createEvalTraceExample, createOutputValidationTrendExport, createReplayEvalExample, deleteEvalTraceExample, listEvalTraceExamples, listEvalTraceRuns, readEvalTraceDataset, recordContextLossEvalRun, recordOutputValidationEvalRun, recordProfileFeedbackEvalRun, recordUploadsFallbackEvalRun, runEvalTraceDataset, summarizeContextLossRuns, summarizeEvalTraceRuns, summarizeOutputValidationRuns, summarizeProfileFeedbackRuns, summarizeUploadsFallbackRuns, updateEvalTraceExampleTags } from '../learning/evalTrace';
import { appendLearningCandidate, extractLearningCandidate, getLearningCandidateProvenance, listReviewedLearningCandidates, reviewLearningCandidate } from '../learning/sessionLearning';
import { listSubagentRoutingMetrics } from '../agents/subagent';
import { calibrateModelRoutingPolicy, summarizeRoutingMetrics } from '../agents/modelRouting';
import { checkSetupHealth } from '../setup/health';
import { getModelCatalog, getModelCatalogCacheStatus } from '../models/modelCatalog';
import { listAutomationJobs, listDueAutomationJobs } from '../automation/jobs';
import { getSessionSearchIndexStatus, rebuildSessionSearchIndexWithMetadata } from '../persistence/sessionSearchIndex';
import type { ModelRoutingPolicy } from '../agents/modelRouting';
import type { LoopConfig, LoopEvent, PermissionMode, Tool } from '../types';
import type { Message } from 'ollama';

const app = express();
app.use(express.json({ limit: '1mb' }));
// Disable browser caching for the SPA shell so users always see the latest
// UI without having to hard-refresh after upgrades.  setHeaders runs for
// every served static file; the agent loop sends its own headers so this
// only affects ui/* (HTML / JS / CSS).
app.use(express.static(path.join(__dirname, '..', '..', 'ui'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

const PROJECT_DIR = process.cwd();
const LOCAL_HOST = process.env.HOST ?? '127.0.0.1';
const HISTORY_DIR = path.join(PROJECT_DIR, '.harness', 'chat-history');
const SKILLS_DIR = path.join(PROJECT_DIR, '.harness', 'skills');
const REPO_SKILLS_DIR = path.join(PROJECT_DIR, '.github', 'skills');
const TRACES_DIR = path.join(PROJECT_DIR, '.harness', 'traces');
const SETTINGS_PATH = path.join(PROJECT_DIR, '.harness', 'settings.json');
const OUTPUT_VALIDATION_PROFILES_PATH = path.join(PROJECT_DIR, '.harness', 'output-validation-profiles.json');
const RELEASE_PROVENANCE_PATH = path.join(PROJECT_DIR, 'release-provenance.json');
const WORKFLOWS_DIR = path.join(PROJECT_DIR, '.harness', 'workflows');
const workflowRegistry = new WorkflowRegistry(WORKFLOWS_DIR);
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
  modelCatalog: ModelCatalogSettings;
  extensionActivation: ExtensionActivationSettings;
  walkthrough: WalkthroughSettings;
  curator: CuratorSettings;
}

interface MediaToolSettings {
  visionModel: string;
  audioTranscribeCommand: string;
  pdfOcrCommand: string;
  uploadsDir: string;
  uploadsAutoPruneDays: number;
  uploadsLastPrunedAt: string;
}

interface OutputValidationSettings {
  enabled: boolean;
  profile: OutputValidationProfile;
  autoSelect: boolean;
  skipOnLowSignal: boolean;
}

interface EffectiveOutputValidationSettings extends OutputValidationSettings {
  selectionSource: 'auto-selected' | 'manual-selected';
  selectionReason: string;
}

interface WalkthroughSettings {
  completed: string[];
}

interface CuratorSettings {
  enabled: boolean;
  intervalHours: number;
  idleThresholdMinutes: number;
  staleDays: number;
  minViewsBeforeArchive: number;
  maxArchivePerRun: number;
  enableLlmPhase: boolean;
  lastRunAt: string;
}

interface ModelCatalogSettings {
  url: string;
  ttlHours: number;
}

interface ExtensionActivationSettings {
  executablePlugins: boolean;
  allowedPluginNames: string[];
  requirePermissionReview: boolean;
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
  pdfOcrCommand: process.env.HARNESS_PDF_OCR_COMMAND ?? '',
  uploadsDir: process.env.HARNESS_UPLOADS_DIR ?? '',
  uploadsAutoPruneDays: 0,
  uploadsLastPrunedAt: '',
};
let outputValidation: OutputValidationSettings = { enabled: false, profile: 'oracle-prime', autoSelect: true, skipOnLowSignal: false };
let customOutputValidationProfiles: CustomOutputValidationProfile[] = [];
let modelCatalog: ModelCatalogSettings = { url: '', ttlHours: 24 };
let extensionActivation: ExtensionActivationSettings = { executablePlugins: false, allowedPluginNames: [], requirePermissionReview: true };
let walkthrough: WalkthroughSettings = { completed: [] };
let settingsLoaded = false;
let killSwitchActive = false;
let killSwitchReason = '';
const disabledTools = new Set<string>();

let curatorSettings: CuratorSettings = sanitizeCuratorSettings({});
let lastUserActivityMs = Date.now();
let curatorScheduler: CuratorScheduler | null = null;

function applyToolDisables(tools: Tool[]): Tool[] {
  if (disabledTools.size === 0) return tools;
  return tools.filter((tool) => !disabledTools.has(tool.name));
}
const rateLimiter = new RateLimiter(10, 2);
const hookPipeline = new HookPipeline();
const permissionPrompts = new PermissionPromptBroker();
const defaultWebRuntime: WebRuntimeDeps = {
  createClient: (model, host, numCtx) => new OllamaClient({ model, host, numCtx }),
  getModelContextWindow: (model, host) => new OllamaClient({ model, host }).getContextWindow(),
  getTools: () => applyToolDisables(getBuiltinTools()),
  createPermissionEngine: (mode) => {
    const engine = new PermissionEngine([], mode);
    if (killSwitchActive) engine.engageKillSwitch(killSwitchReason);
    return engine;
  },
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
setRagRuntime({ projectDir: PROJECT_DIR, ollamaHost });

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
    setRagRuntime({ ollamaHost });
  }
  if (req.body.systemPrompt !== undefined) systemPromptOverride = String(req.body.systemPrompt).slice(0, 20_000);
  if (req.body.summarizerModel !== undefined) summarizerModel = sanitizeModelName(req.body.summarizerModel);
  if (req.body.modelRouting !== undefined) modelRouting = sanitizeModelRoutingPolicy(req.body.modelRouting);
  if (req.body.mediaTools !== undefined) {
    mediaTools = sanitizeMediaToolSettings(req.body.mediaTools);
    applyMediaToolEnvironment(mediaTools);
    configureUploadsAutoPrune();
  }
  if (req.body.outputValidation !== undefined) outputValidation = sanitizeOutputValidationSettings(req.body.outputValidation);
  if (req.body.modelCatalog !== undefined) modelCatalog = sanitizeModelCatalogSettings(req.body.modelCatalog);
  if (req.body.extensionActivation !== undefined) extensionActivation = sanitizeExtensionActivationSettings(req.body.extensionActivation);
  if (req.body.walkthrough !== undefined) walkthrough = sanitizeWalkthroughSettings(req.body.walkthrough);
  if (req.body.curator !== undefined) {
    curatorSettings = sanitizeCuratorSettings(req.body.curator);
    configureCuratorScheduler();
  }
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

app.post('/api/output-validation/suggest-profile', async (req, res) => {
  await ensureSettingsLoaded();
  const input = String(req.body?.input ?? req.body?.message ?? '').slice(0, 20_000);
  const suggestion = describeOutputValidationProfileSuggestion(input, 'oracle-prime');
  const metadata = OUTPUT_VALIDATION_PROFILES.find((candidate) => candidate.profile === suggestion.profile);
  res.json({ profile: suggestion.profile, label: metadata?.label ?? suggestion.profile, reason: suggestionReason(suggestion.profile, suggestion.matched), matched: suggestion.matched });
});

app.post('/api/output-validation/feedback', async (req, res) => {
  await ensureSettingsLoaded();
  const profile = String(req.body?.profile ?? '').trim();
  const voteRaw = String(req.body?.vote ?? '').trim().toLowerCase();
  if (!profile) { res.status(400).json({ error: 'profile is required' }); return; }
  if (voteRaw !== 'up' && voteRaw !== 'down') { res.status(400).json({ error: 'vote must be "up" or "down"' }); return; }
  const selectionSourceRaw = String(req.body?.selectionSource ?? 'auto-selected');
  const selectionSource = selectionSourceRaw === 'manual-selected' ? 'manual-selected' : 'auto-selected';
  const run = await recordProfileFeedbackEvalRun(PROJECT_DIR, {
    profile,
    vote: voteRaw,
    selectionSource,
    selectionReason: req.body?.selectionReason ? String(req.body.selectionReason).slice(0, 500) : undefined,
    prompt: req.body?.prompt ? String(req.body.prompt).slice(0, 500) : undefined,
  });
  res.json({ ok: true, runId: run.id });
});

app.get('/api/output-validation/feedback-replay', async (_req, res) => {
  await ensureSettingsLoaded();
  const runs = await listEvalTraceRuns(PROJECT_DIR);
  const PLACEHOLDER_TASK = 'validation profile feedback';
  const replays: Array<{ originalProfile: string; suggestedProfile: string; matched: boolean; prompt: string; createdAt: string; status: 'fixed' | 'still-misclassified' | 'no-prompt' }> = [];
  let fixed = 0;
  let stillMisclassified = 0;
  let noPrompt = 0;
  for (const run of runs) {
    for (const result of run.results) {
      if (!result.tags.includes('profile-feedback:down')) continue;
      const originalProfile = result.tags.find((tag) => tag !== 'profile-feedback'
        && tag !== 'profile-feedback:down'
        && tag !== 'auto-selected'
        && tag !== 'manual-selected') ?? 'unknown';
      const prompt = result.task && result.task !== PLACEHOLDER_TASK ? result.task : '';
      if (!prompt) {
        noPrompt++;
        replays.push({ originalProfile, suggestedProfile: originalProfile, matched: false, prompt: '', createdAt: run.createdAt, status: 'no-prompt' });
        continue;
      }
      const suggestion = describeOutputValidationProfileSuggestion(prompt, 'oracle-prime');
      const status: 'fixed' | 'still-misclassified' = suggestion.profile !== originalProfile ? 'fixed' : 'still-misclassified';
      if (status === 'fixed') fixed++; else stillMisclassified++;
      replays.push({ originalProfile, suggestedProfile: suggestion.profile, matched: suggestion.matched, prompt, createdAt: run.createdAt, status });
    }
  }
  res.json({
    generatedAt: new Date().toISOString(),
    totalDownVotes: replays.length,
    fixed,
    stillMisclassified,
    noPrompt,
    replays: replays.slice(-50).reverse(),
  });
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
  const requestedPdfOcrCommand = typeof req.query.pdfOcrCommand === 'string'
    ? String(req.query.pdfOcrCommand).trim()
    : mediaTools.pdfOcrCommand;
  res.json(await checkSetupHealth({
    host: parsedHost,
    visionModel: requestedVisionModel,
    audioTranscribeCommand: requestedAudioCommand,
    audioSamplePath: requestedAudioSamplePath || undefined,
    pdfOcrCommand: requestedPdfOcrCommand || undefined,
  }));
});

app.get('/api/discovery', async (_req, res) => {
  await ensureSettingsLoaded();
  try {
    const ttlMs = modelCatalog.ttlHours * 60 * 60 * 1000;
    const [catalog, catalogStatus, extensions, automationJobs, dueAutomations, sessionSearch, runtimeSkills, repoSkills] = await Promise.all([
      getModelCatalog(PROJECT_DIR, { url: modelCatalog.url || undefined, ttlMs, fetchJson: fetchJsonFromUrl }),
      getModelCatalogCacheStatus(PROJECT_DIR, new Date(), ttlMs),
      discoverExtensionManifests(PROJECT_DIR),
      listAutomationJobs(PROJECT_DIR),
      listDueAutomationJobs(PROJECT_DIR),
      getSessionSearchIndexStatus(PROJECT_DIR),
      scanSkillsDir(SKILLS_DIR),
      scanSkillsDir(REPO_SKILLS_DIR),
    ]);
    res.json({
      modelCatalog: { settings: modelCatalog, status: catalogStatus, manifest: catalog },
      extensions: {
        policy: extensionActivation,
        manifests: extensions.map((manifest) => ({ ...manifest, activation: describeExtensionActivation(manifest.kind, manifest.name, manifest.enabled) })),
        skills: {
          runtime: { directory: SKILLS_DIR, total: runtimeSkills.skills.length, diagnosticCount: runtimeSkills.diagnostics.length, diagnostics: runtimeSkills.diagnostics },
          repo: { directory: REPO_SKILLS_DIR, total: repoSkills.skills.length, diagnosticCount: repoSkills.diagnostics.length },
        },
      },
      automations: { total: automationJobs.length, due: dueAutomations, jobs: automationJobs },
      sessionSearch,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/models/catalog/refresh', async (_req, res) => {
  await ensureSettingsLoaded();
  try {
    const ttlMs = modelCatalog.ttlHours * 60 * 60 * 1000;
    const manifest = await getModelCatalog(PROJECT_DIR, { url: modelCatalog.url || undefined, ttlMs, forceRefresh: true, fetchJson: fetchJsonFromUrl });
    const status = await getModelCatalogCacheStatus(PROJECT_DIR, new Date(), ttlMs);
    res.json({ settings: modelCatalog, status, manifest });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/sessions/search-index/rebuild', async (_req, res) => {
  try {
    const index = await rebuildSessionSearchIndexWithMetadata(PROJECT_DIR);
    const status = await getSessionSearchIndexStatus(PROJECT_DIR);
    res.json({ index, status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/pdf/extract', async (req, res) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
  const startPage = typeof req.query.startPage === 'string' ? Number(req.query.startPage) : undefined;
  const endPage = typeof req.query.endPage === 'string' ? Number(req.query.endPage) : undefined;
  const resolved = rawPath ? resolveProjectReadPath(rawPath) : null;
  if (!resolved) {
    res.status(400).json({ error: 'path is required and must be inside the project or uploads directory' });
    return;
  }
  if (path.extname(resolved).toLowerCase() !== '.pdf') {
    res.status(400).json({ error: 'file must have a .pdf extension' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  let aborted = false;
  req.on('close', () => { aborted = true; });
  try {
    const stat = await fs.stat(resolved);
    if (stat.size > MAX_PDF_BYTES) {
      writeEvent('error', { message: `PDF exceeds ${MAX_PDF_BYTES} bytes (${stat.size}).` });
      return;
    }
    const data = await fs.readFile(resolved);
    let count = 0;
    for await (const chunk of iteratePdfPages(data, { startPage, endPage })) {
      if (aborted) break;
      writeEvent('page', chunk);
      count++;
    }
    writeEvent('done', { pages: count });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    writeEvent('error', { message: msg });
  } finally {
    if (!res.writableEnded) res.end();
  }
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
    res.json({ runs, trend: summarizeEvalTraceRuns(runs), outputValidationTrend: summarizeOutputValidationRuns(runs), profileFeedbackTrend: summarizeProfileFeedbackRuns(runs), contextLossTrend: summarizeContextLossRuns(runs), uploadsFallbackTrend: summarizeUploadsFallbackRuns(runs) });
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

// Read-only view of the permission posture for the Permissions UI.
app.get('/api/permissions/state', (_req, res) => {
  res.json({
    mode: permissionMode,
    allowedModes: ALLOWED_PERMISSION_MODES,
    killSwitch: { active: killSwitchActive, reason: killSwitchReason },
    pendingCount: permissionPrompts.list().length,
  });
});

// Engage or release the global kill switch. Once engaged, the permission
// engine denies every subsequent tool call until released.
app.post('/api/permissions/kill-switch', (req, res) => {
  const desired = Boolean(req.body?.active);
  if (desired) {
    killSwitchActive = true;
    killSwitchReason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? String(req.body.reason).trim().slice(0, 500)
      : 'Kill switch engaged from dashboard.';
    logger.warn('Permissions', 'Kill switch engaged', { reason: killSwitchReason });
    runtimeTracer.recordEvent('permission.kill_switch_engaged', { reason: killSwitchReason });
  } else {
    killSwitchActive = false;
    killSwitchReason = '';
    logger.info('Permissions', 'Kill switch released');
    runtimeTracer.recordEvent('permission.kill_switch_released', {});
  }
  res.json({ killSwitch: { active: killSwitchActive, reason: killSwitchReason } });
});

// Read-only registry view for the Tools dashboard. Returns one entry per
// registered tool with risk/category metadata grouped by toolset.
app.get('/api/tools', (_req, res) => {
  try {
    const registry = createBuiltinToolRegistry();
    const tools = registry.listEntries().map((entry) => ({
      name: entry.tool.name,
      description: entry.tool.description,
      toolset: entry.toolset,
      source: entry.source,
      enabledByDefault: entry.enabledByDefault,
      enabled: !disabledTools.has(entry.tool.name),
      isReadOnly: entry.tool.isReadOnly,
      riskLevel: entry.riskLevel,
      permissionCategory: entry.permissionCategory,
      canDryRun: entry.canDryRun,
    }));
    const toolsets: Record<string, number> = {};
    for (const tool of tools) toolsets[tool.toolset] = (toolsets[tool.toolset] ?? 0) + 1;
    res.json({ tools, toolsets, disabled: Array.from(disabledTools).sort() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Enable or disable a single tool at runtime. Disabled tools are filtered out
// of the agent's tool list before each chat turn.
app.post('/api/tools/:name/toggle', (req, res) => {
  const toolName = String(req.params.name || '').trim();
  if (!toolName) { res.status(400).json({ error: 'tool name required' }); return; }
  const registry = createBuiltinToolRegistry();
  if (!registry.get(toolName)) { res.status(404).json({ error: 'unknown tool' }); return; }
  const currentlyEnabled = !disabledTools.has(toolName);
  const desiredEnabled = req.body?.enabled === undefined ? !currentlyEnabled : Boolean(req.body.enabled);
  if (desiredEnabled) disabledTools.delete(toolName);
  else disabledTools.add(toolName);
  logger.info('Tools', 'Tool toggled', { tool: toolName, enabled: desiredEnabled });
  res.json({ name: toolName, enabled: desiredEnabled, disabled: Array.from(disabledTools).sort() });
});

// --- Workflows ---
// Read the workflow file index. Workflows live under .harness/workflows/<name>.
app.get('/api/workflows', async (_req, res) => {
  try {
    const workflows = await workflowRegistry.list();
    res.json({ workflows: workflows.map((wf) => ({ ...wf, stepCount: wf.steps.length })) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/workflows/:name', async (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) { res.status(400).json({ error: 'workflow name required' }); return; }
  try {
    const definition = await workflowRegistry.load(name);
    if (!definition) { res.status(404).json({ error: 'workflow not found' }); return; }
    res.json(definition);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Start a run. Optional body: { dryRun: boolean, variables: object }.
app.post('/api/workflows/:name/run', async (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) { res.status(400).json({ error: 'workflow name required' }); return; }
  try {
    const definition = await workflowRegistry.load(name);
    if (!definition) { res.status(404).json({ error: 'workflow not found' }); return; }
    const dryRun = Boolean(req.body?.dryRun);
    const variables = typeof req.body?.variables === 'object' && req.body.variables !== null ? req.body.variables : undefined;
    const run = workflowRegistry.startRun(definition, { dryRun, variables });
    const tools = applyToolDisables(getBuiltinTools());
    const permissions = webRuntime.createPermissionEngine(permissionMode);
    // Execute asynchronously so the HTTP request returns immediately with the
    // initial run state. Errors are captured on the run object itself.
    workflowRegistry.execute(run.id, { tools, permissions }).catch((error) => {
      logger.warn('Workflow', 'Workflow run threw', { runId: run.id, error: error instanceof Error ? error.message : String(error) });
    });
    res.json({ run });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/workflows/runs', (_req, res) => {
  res.json({ runs: workflowRegistry.listRuns() });
});

app.get('/api/workflows/runs/:id', (req, res) => {
  const run = workflowRegistry.getRun(String(req.params.id || ''));
  if (!run) { res.status(404).json({ error: 'run not found' }); return; }
  res.json({ run });
});

app.post('/api/workflows/runs/:id/pause', (req, res) => {
  const ok = workflowRegistry.pause(String(req.params.id || ''), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
  if (!ok) { res.status(409).json({ error: 'run is not running' }); return; }
  res.json({ ok: true });
});

app.post('/api/workflows/runs/:id/resume', async (req, res) => {
  const id = String(req.params.id || '');
  const run = workflowRegistry.getRun(id);
  if (!run) { res.status(404).json({ error: 'run not found' }); return; }
  if (!workflowRegistry.resume(id)) { res.status(409).json({ error: 'run is not paused' }); return; }
  const tools = applyToolDisables(getBuiltinTools());
  const permissions = webRuntime.createPermissionEngine(permissionMode);
  workflowRegistry.execute(id, { tools, permissions }).catch((error) => {
    logger.warn('Workflow', 'Workflow run threw on resume', { runId: id, error: error instanceof Error ? error.message : String(error) });
  });
  res.json({ ok: true });
});

app.post('/api/workflows/runs/:id/cancel', (req, res) => {
  const ok = workflowRegistry.cancel(String(req.params.id || ''), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
  if (!ok) { res.status(409).json({ error: 'run cannot be cancelled' }); return; }
  res.json({ ok: true });
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
  lastUserActivityMs = Date.now();
  const { message, model } = req.body;
  if (!message) { res.status(400).json({ error: 'message is required' }); return; }

  const activeModel = model || currentModel;
  if (!activeModel) { res.status(400).json({ error: 'No model selected.' }); return; }

  const skipValidationThisTurn = req.body?.skipValidation === true;
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
  const activeOutputValidation = skipValidationThisTurn
    ? { ...outputValidation, enabled: false, selectionSource: 'manual-selected' as const, selectionReason: 'Validation skipped for this turn by user request.' }
    : effectiveOutputValidationForMessage(message);
  const client = webRuntime.createClient(activeModel, ollamaHost, activeContextMaxTokens);
  const tools = webRuntime.getTools();
  const permissions = webRuntime.createPermissionEngine(permissionMode);
  const projectDir = PROJECT_DIR;

  // Start a new learning session for tracking
  webRuntime.startNewSession();
  // Drain any stale uploads-fallback records so this turn only sees its own.
  drainUploadsFallbacks();

  const basePrompt = systemPromptOverride ||
    'You are a self-learning AI assistant with full web access and local tool use. IMPORTANT RULES:\n' +
    '1. When the user asks about something on the web (weather, news, docs, prices, etc.), ALWAYS use web_search to find it, then web_read to fetch the actual content. NEVER just suggest links — fetch the data yourself and show the results.\n' +
    '2. You can read files, write files, edit code, run commands, search files with grep, search the web, and read web pages.\n' +
    '3. When you notice a reusable pattern, create a skill. When you learn something important, use the remember tool.\n' +
    '4. Format responses in Markdown.\n' +
    '5. Be direct — do the work, don\'t ask the user to do it themselves.';

  // Use evolved prompt — layers in learned patterns and self-improvements
  const evolvedPrompt = await webRuntime.getEvolvedPrompt(basePrompt);
  const baseSystemPrompt = await webRuntime.assembleSystemContext({ systemPrompt: withRoutingPolicy(evolvedPrompt), projectDir, skillsDir: SKILLS_DIR });
  const attachmentsBlock = await buildAttachmentsContextBlock(req.body?.attachments);
  const systemPrompt = attachmentsBlock ? `${baseSystemPrompt}\n\n${attachmentsBlock}` : baseSystemPrompt;

  const config: LoopConfig = {
    model: activeModel,
    systemPrompt,
    maxTurns: 25,
    abortSignal: abortController.signal,
    context: { maxTokens: activeContextMaxTokens, summarizerModel },
    outputValidation: {
      enabled: activeOutputValidation.enabled,
      profile: activeOutputValidation.profile,
      customProfiles: customOutputValidationProfiles,
    },
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

  const messages: Message[] = [];
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const sanitizedHistory: Message[] = [];
  // Cap to the last 50 turns; cap each message to 200KB to bound payload size and let
  // the existing context compaction (activeContextMaxTokens, summarizerModel) trim further.
  for (const item of rawHistory.slice(-50)) {
    const role = item && (item.role === 'assistant' || item.role === 'user') ? item.role : null;
    if (!role) continue;
    const content = typeof item.content === 'string' ? item.content.slice(0, 200_000) : '';
    if (!content) continue;
    sanitizedHistory.push({ role, content });
  }
  // Reserve ~25% of the model context window for the new user message, system prompt,
  // tool schemas, and assistant reply; spend the rest on prior history. Drop oldest turns
  // first until the remaining history fits the budget.
  const newUserMessage: Message = { role: 'user', content: message };
  const historyTokenBudget = Math.max(512, Math.floor(activeContextMaxTokens * 0.75) - estimateTokenCount([newUserMessage]));
  let trimmedHistory = sanitizedHistory;
  let droppedForTokens = 0;
  while (trimmedHistory.length > 0 && estimateTokenCount(trimmedHistory) > historyTokenBudget) {
    trimmedHistory = trimmedHistory.slice(1);
    droppedForTokens++;
  }
  messages.push(...trimmedHistory, newUserMessage);
  logger.info('Chat', `User: ${message.slice(0, 80)}`, { model: activeModel, historyTurns: trimmedHistory.length, droppedForTokens, historyTokenBudget });
  let assistantTextBuffer = '';

  try {
    if (droppedForTokens > 0) {
      res.write(`data: ${JSON.stringify({
        type: 'history_trimmed',
        droppedTurns: droppedForTokens,
        keptTurns: trimmedHistory.length,
        historyTokenBudget,
      })}\n\n`);
    }
    if (activeOutputValidation.enabled && activeOutputValidation.selectionSource === 'auto-selected') {
      res.write(`data: ${JSON.stringify({
        type: 'output_validation_profile',
        profile: activeOutputValidation.profile,
        source: activeOutputValidation.selectionSource,
        reason: activeOutputValidation.selectionReason,
      })}\n\n`);
    }
    const seenFallbackKeys = new Set<string>();
    let suppressedFallbacks = 0;
    for await (const event of webRuntime.runQueryLoop(config, deps, messages)) {
      if (event.type === 'output_validation') {
        await recordOutputValidationEvalRun(PROJECT_DIR, event.validation, message.slice(0, 120), {
          selectionSource: activeOutputValidation.selectionSource,
          selectionReason: activeOutputValidation.selectionReason,
        });
      }
      if (event.type === 'text' && typeof event.content === 'string') {
        assistantTextBuffer += event.content;
      }
      const data = JSON.stringify(event);
      res.write(`data: ${data}\n\n`);
      if (event.type === 'tool_result') {
        const fallbacks = drainUploadsFallbacks();
        for (const fb of fallbacks) {
          const cwdRel = path.relative(PROJECT_DIR, fb.resolved);
          const resolvedRel = (cwdRel.startsWith('..') ? fb.resolved : cwdRel).split(path.sep).join('/');
          const key = `${event.call?.name ?? ''}|${fb.requested}|${resolvedRel}`;
          if (seenFallbackKeys.has(key)) {
            suppressedFallbacks++;
            continue;
          }
          seenFallbackKeys.add(key);
          runtimeTracer.recordEvent('uploads.fallback', {
            tool: event.call?.name,
            requested: fb.requested,
            resolved: resolvedRel,
          });
          res.write(`data: ${JSON.stringify({
            type: 'uploads_fallback',
            tool: event.call?.name,
            requested: fb.requested,
            resolved: resolvedRel,
            at: fb.at,
          })}\n\n`);
        }
      }
    }
    if (suppressedFallbacks > 0) {
      runtimeTracer.recordEvent('uploads.fallback_summary', {
        suppressed: suppressedFallbacks,
        unique: seenFallbackKeys.size,
      });
      res.write(`data: ${JSON.stringify({
        type: 'uploads_fallback_summary',
        suppressed: suppressedFallbacks,
        unique: seenFallbackKeys.size,
      })}\n\n`);
    }
    if (seenFallbackKeys.size > 0) {
      const tools = Array.from(new Set(Array.from(seenFallbackKeys).map((key) => key.split('|')[0]).filter((tool) => tool)));
      runtimeTracer.recordEvent('uploads.fallback_advice', { unique: seenFallbackKeys.size, tools });
      res.write(`data: ${JSON.stringify({
        type: 'uploads_fallback_advice',
        unique: seenFallbackKeys.size,
        tools,
        message: `Model passed bare filenames ${seenFallbackKeys.size} time(s); call list_uploads first or pass the exact attachment path to avoid silent fallbacks.`,
      })}\n\n`);
      try {
        await recordUploadsFallbackEvalRun(PROJECT_DIR, {
          uniqueFallbacks: seenFallbackKeys.size,
          suppressedFallbacks,
          tools,
          sessionId: session.getSessionId(),
          task: message.slice(0, 120),
        });
      } catch (error) {
        logger.warn('Chat', 'uploads-fallback eval record failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (assistantTextBuffer.trim() && trimmedHistory.length > 0) {
      const lastAssistant = [...trimmedHistory].reverse().find((entry) => entry.role === 'assistant');
      try {
        await recordContextLossEvalRun(PROJECT_DIR, {
          priorUserMessage: message,
          priorAssistantMessage: lastAssistant?.content,
          assistantResponse: assistantTextBuffer,
          task: message.slice(0, 120),
        });
      } catch (error) {
        logger.warn('Chat', 'context-loss check failed', { error: error instanceof Error ? error.message : String(error) });
      }
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

// Runs view: same source as /api/sessions but enriched with derived fields
// (duration, age) the dashboard renders without per-row computation.
app.get('/api/runs', async (_req, res) => {
  try {
    const sessions = await SessionStorage.listSessions(PROJECT_DIR);
    const now = Date.now();
    const runs = sessions.map((session) => {
      const startMs = Date.parse(session.createdAt);
      const endMs = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
      const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
      const ageMs = Number.isFinite(startMs) ? Math.max(0, now - startMs) : null;
      return {
        sessionId: session.sessionId,
        title: session.title || 'Untitled run',
        model: session.model,
        status: session.status || 'unknown',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        durationMs,
        ageMs,
        checkpointCount: session.checkpointCount ?? 0,
        lastError: session.lastError,
        parentSessionId: session.parentSessionId,
      };
    });
    const counts: Record<string, number> = {};
    for (const run of runs) counts[run.status] = (counts[run.status] ?? 0) + 1;
    res.json({ runs, total: runs.length, counts });
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

// --- API: Snapshots (skills, memory, config) ---
// Lightweight point-in-time copies of `.harness/skills`, MEMORY.md,
// USER.md, SOUL.md so users can roll back self-improvement edits or
// recover a tree they accidentally clobbered.

app.get('/api/snapshots', async (_req, res) => {
  try {
    res.json({ snapshots: await snapshots.list(PROJECT_DIR) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/snapshots', async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
    const meta = await snapshots.take(PROJECT_DIR, reason);
    res.json({ snapshot: meta });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/snapshots/:id/diff', async (req, res) => {
  try {
    const diff = await snapshots.diff(PROJECT_DIR, req.params.id);
    if (!diff) { res.status(404).json({ error: 'snapshot not found' }); return; }
    res.json(diff);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/snapshots/:id/restore', async (req, res) => {
  try {
    const result = await snapshots.restore(PROJECT_DIR, req.params.id);
    if (!result) { res.status(404).json({ error: 'snapshot not found' }); return; }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/snapshots/:id', async (req, res) => {
  try {
    const ok = await snapshots.remove(PROJECT_DIR, req.params.id);
    if (!ok) { res.status(404).json({ error: 'snapshot not found' }); return; }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// --- API: Local RAG indexes ---
// Build, query, and drop semantic indexes over arbitrary local files.
// Backend is auto-detected: prefers Ollama embeddings when reachable,
// falls back to a deterministic feature-hash so the UI works offline.

app.get('/api/rag/indexes', async (_req, res) => {
  try {
    res.json({ indexes: await ragIndex.listIndexes(PROJECT_DIR) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/rag/build', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p: unknown) => String(p)) : [];
    const backend = req.body?.backend === 'ollama' || req.body?.backend === 'hash' ? req.body.backend : undefined;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    if (paths.length === 0) { res.status(400).json({ error: 'at least one path is required' }); return; }
    const result = await ragIndex.build(PROJECT_DIR, name, paths, { backend, ollamaHost });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/rag/preview', async (req, res) => {
  try {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p: unknown) => String(p)) : [];
    if (paths.length === 0) { res.status(400).json({ error: 'at least one path is required' }); return; }
    const preview = await ragIndex.previewBuild(PROJECT_DIR, paths);
    const backend = await ragIndex.selectBackend(ollamaHost, undefined);
    res.json({ ...preview, backend });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Streamed build with progress events (SSE) so the UI can show file-by-file
// progress for long indexing runs. Body shape matches POST /api/rag/build.
app.post('/api/rag/build/stream', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p: unknown) => String(p)) : [];
  const backend = req.body?.backend === 'ollama' || req.body?.backend === 'hash' ? req.body.backend : undefined;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  if (paths.length === 0) { res.status(400).json({ error: 'at least one path is required' }); return; }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  let aborted = false;
  res.on('close', () => { aborted = true; });
  try {
    for await (const event of ragIndex.iterateBuild(PROJECT_DIR, name, paths, { backend, ollamaHost })) {
      if (aborted) break;
      writeEvent(event.stage, event);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    writeEvent('error', { message: msg });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post('/api/rag/search', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const query = String(req.body?.query || '').trim();
    const k = Number.isFinite(req.body?.k) ? Math.max(1, Math.min(20, Number(req.body.k))) : 5;
    if (!name || !query) { res.status(400).json({ error: 'name and query are required' }); return; }
    const results = await ragIndex.search(PROJECT_DIR, name, query, { k, ollamaHost });
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/rag/indexes/:name', async (req, res) => {
  try {
    const ok = await ragIndex.dropIndex(PROJECT_DIR, req.params.name);
    if (!ok) { res.status(404).json({ error: 'index not found' }); return; }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// --- API: MCP catalog (curated, in-process; no network call) ---
// The Harness doesn't run MCP servers itself today; this endpoint is a
// discovery aid so the UI can show users what's out there with an
// install command they can paste into a terminal.

app.get('/api/mcp/catalog', (_req, res) => {
  res.json({ catalog: MCP_CATALOG });
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
    const [runtime, repo] = await Promise.all([
      scanSkillsDir(SKILLS_DIR),
      scanSkillsDir(REPO_SKILLS_DIR),
    ]);
    const mapSkill = (source: 'runtime' | 'repo') => (s: Awaited<ReturnType<typeof loadSkillsDir>>[number]) => ({ name: s.name, description: s.description, domain: s.domain, triggers: s.triggers, filePath: s.filePath, source });
    res.json({
      skills: runtime.skills.map(mapSkill('runtime')),
      diagnostics: runtime.diagnostics,
      sources: [
        { source: 'runtime', label: 'Runtime skills', directory: SKILLS_DIR, skills: runtime.skills.map(mapSkill('runtime')), diagnostics: runtime.diagnostics, mutable: true },
        { source: 'repo', label: 'Repo skills', directory: REPO_SKILLS_DIR, skills: repo.skills.map(mapSkill('repo')), diagnostics: repo.diagnostics, mutable: false },
      ],
    });
  } catch { res.json({ skills: [], diagnostics: [], sources: [] }); }
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

// Install a read-only repo skill (.github/skills/<name>) into runtime (.harness/skills/<name>).
app.post('/api/skills/install', async (req, res) => {
  const skillName = safeLocalId(req.body?.name);
  if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
  const overwrite = Boolean(req.body?.overwrite);
  const sourceDir = path.join(REPO_SKILLS_DIR, skillName);
  const destDir = path.join(SKILLS_DIR, skillName);
  try {
    const sourceStat = await fs.stat(sourceDir).catch(() => null);
    if (!sourceStat || !sourceStat.isDirectory()) {
      res.status(404).json({ error: 'Source skill not found in .github/skills.' });
      return;
    }
    const sourceScan = await scanSkillsDir(REPO_SKILLS_DIR);
    const sourceSkill = sourceScan.skills.find((s) => path.dirname(s.filePath) === sourceDir);
    if (!sourceSkill) {
      res.status(400).json({ error: 'Source skill is malformed and cannot be installed. Fix SKILL.md frontmatter first.' });
      return;
    }
    const destStat = await fs.stat(destDir).catch(() => null);
    if (destStat && !overwrite) {
      res.status(409).json({ error: 'Runtime skill already exists. Pass overwrite=true to replace it.' });
      return;
    }
    if (destStat) await fs.rm(destDir, { recursive: true, force: true });
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.cp(sourceDir, destDir, { recursive: true });
    res.json({ ok: true, name: skillName, source: sourceDir, destination: destDir, overwrote: Boolean(destStat) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Create a starter SKILL.md scaffold for a runtime skill folder that is missing one.
app.post('/api/skills/scaffold', async (req, res) => {
  const skillName = safeLocalId(req.body?.name);
  if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
  const skillDir = path.join(SKILLS_DIR, skillName);
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    await fs.mkdir(skillDir, { recursive: true });
    const existing = await fs.stat(skillFile).catch(() => null);
    if (existing) {
      res.status(409).json({ error: 'SKILL.md already exists. Edit the file directly to repair frontmatter.' });
      return;
    }
    const description = typeof req.body?.description === 'string' && req.body.description.trim()
      ? String(req.body.description).trim()
      : 'Describe what this skill does.';
    const domain = typeof req.body?.domain === 'string' && req.body.domain.trim()
      ? String(req.body.domain).trim()
      : 'general';
    const scaffold = `---\nname: ${skillName}\ndescription: ${description}\ndomain: ${domain}\ntriggers: []\n---\n\n# ${skillName}\n\nDescribe how to use this skill here.\n`;
    await fs.writeFile(skillFile, scaffold, 'utf-8');
    res.json({ ok: true, name: skillName, filePath: skillFile });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Pin / unpin a skill so the curator never archives it.
app.post('/api/skills/:name/pin', async (req, res) => {
  const skillName = safeLocalId(req.params.name);
  if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
  const desired = req.body?.pinned === undefined ? true : Boolean(req.body.pinned);
  try {
    const record = await setSkillPinned(PROJECT_DIR, skillName, desired);
    res.json({ ok: true, record });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/skills/usage', async (_req, res) => {
  try {
    const records = await listSkillUsage(PROJECT_DIR);
    res.json({ records });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// --- API: Curator ---
app.get('/api/curator', async (_req, res) => {
  try {
    const log = await readCuratorLog(PROJECT_DIR, 50);
    const proposals = await readCuratorProposals(PROJECT_DIR);
    res.json({
      settings: curatorSettings,
      lastUserActivityAt: new Date(lastUserActivityMs).toISOString(),
      schedulerRunning: Boolean(curatorScheduler),
      log,
      proposals,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Manually trigger a curator preview (dry-run, never mutates).
app.post('/api/curator/preview', async (_req, res) => {
  try {
    const summary = await runDeterministicPhase(PROJECT_DIR, curatorConfigFromSettings(), curatorDeps(), { dryRun: true });
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Manually trigger a curator run. Honors the kill switch.
app.post('/api/curator/run', async (_req, res) => {
  try {
    const summary = await runCurator(PROJECT_DIR, curatorConfigFromSettings(), curatorDeps());
    if (!summary.dryRun) {
      curatorSettings = { ...curatorSettings, lastRunAt: new Date().toISOString() };
      await saveSettingsToDisk().catch(() => {});
    }
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Restore an archived skill.
app.post('/api/curator/restore/:name', async (req, res) => {
  const skillName = safeLocalId(req.params.name);
  if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
  try {
    const result = await restoreSkill(PROJECT_DIR, skillName);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
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
  result.profileFeedbackTrend = summarizeProfileFeedbackRuns(evalRuns);
  result.contextLossTrend = summarizeContextLossRuns(evalRuns);
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
    const uploadsDir = getUploadsDir();
    await fs.mkdir(uploadsDir, { recursive: true });
    const dest = path.join(uploadsDir, safe);
    await fs.writeFile(dest, req.body);
    logger.info('Upload', `File saved: ${safe} (${req.body.length} bytes)`);
    const mimeType = req.headers['content-type']?.toString() || 'application/octet-stream';
    res.json({ path: dest, name: safe, size: req.body.length, mimeType, mediaKind: inferMediaKind(safe, mimeType) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

function inferMediaKind(fileName: string, mimeType: string): 'image' | 'audio' | 'pdf' | 'text' | 'data' | 'other' {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lowerName)) return 'image';
  if (lowerMime.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|opus)$/.test(lowerName)) return 'audio';
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) return 'pdf';
  if (lowerMime.startsWith('text/') || /\.(txt|md|csv|json|log|ts|js|py|cs|rs|html|css)$/.test(lowerName)) return 'text';
  if (/\.(jsonl|xml|yaml|yml|parquet|sqlite|db)$/.test(lowerName)) return 'data';
  return 'other';
}

app.get('/api/uploads', async (_req, res) => {
  const uploadsDir = getUploadsDir();
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
    const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    const files = [];
    let totalBytes = 0;
    let oldestMs: number | null = null;
    for (const e of entries.filter(e => e.isFile())) {
      const stat = await fs.stat(path.join(uploadsDir, e.name));
      const mtime = stat.mtime.getTime();
      totalBytes += stat.size;
      if (oldestMs === null || mtime < oldestMs) oldestMs = mtime;
      files.push({ name: e.name, path: path.join(uploadsDir, e.name), size: stat.size, modified: stat.mtime.toISOString() });
    }
    res.json({
      files,
      directory: uploadsDir,
      totalBytes,
      oldest: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
    });
  } catch { res.json({ files: [], directory: uploadsDir, totalBytes: 0, oldest: null }); }
});

app.delete('/api/uploads/:name', async (req, res) => {
  const safe = safeLocalId(path.basename(req.params.name));
  if (!safe) { res.status(400).json({ error: 'Invalid upload name.' }); return; }
  try {
    await fs.unlink(path.join(getUploadsDir(), safe));
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

app.post('/api/uploads/cleanup', async (req, res) => {
  const days = clampNumber(req.body?.olderThanDays, 0, 3650, 30);
  if (days <= 0) {
    res.status(400).json({ error: 'olderThanDays must be greater than 0 for manual cleanup.' });
    return;
  }
  try {
    const result = await pruneUploads(days);
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

async function pruneUploads(olderThanDays: number): Promise<{ removed: Array<{ name: string; size: number; modified: string }>; removedBytes: number; olderThanDays: number; lastPrunedAt: string }> {
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const uploadsDir = getUploadsDir();
  await fs.mkdir(uploadsDir, { recursive: true });
  const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
  const removed: Array<{ name: string; size: number; modified: string }> = [];
  let removedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(uploadsDir, entry.name);
    const stat = await fs.stat(full);
    if (stat.mtime.getTime() < cutoffMs) {
      await fs.unlink(full);
      removed.push({ name: entry.name, size: stat.size, modified: stat.mtime.toISOString() });
      removedBytes += stat.size;
    }
  }
  const lastPrunedAt = new Date().toISOString();
  mediaTools = { ...mediaTools, uploadsLastPrunedAt: lastPrunedAt };
  await saveSettingsToDisk().catch(() => {});
  logger.info('Uploads', `Pruned ${removed.length} file(s) older than ${olderThanDays} days`, { removedBytes });
  return { removed, removedBytes, olderThanDays, lastPrunedAt };
}

let uploadsAutoPruneTimer: NodeJS.Timeout | null = null;
const UPLOADS_AUTO_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function configureUploadsAutoPrune(): void {
  if (uploadsAutoPruneTimer) {
    clearInterval(uploadsAutoPruneTimer);
    uploadsAutoPruneTimer = null;
  }
  if (mediaTools.uploadsAutoPruneDays <= 0) return;
  uploadsAutoPruneTimer = setInterval(() => {
    pruneUploads(mediaTools.uploadsAutoPruneDays).catch((error) => {
      logger.warn('Uploads', 'Scheduled auto-prune failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }, UPLOADS_AUTO_PRUNE_INTERVAL_MS);
  if (typeof uploadsAutoPruneTimer.unref === 'function') uploadsAutoPruneTimer.unref();
}

export function stopUploadsAutoPrune(): void {
  if (uploadsAutoPruneTimer) {
    clearInterval(uploadsAutoPruneTimer);
    uploadsAutoPruneTimer = null;
  }
}

function curatorConfigFromSettings(): CuratorConfig {
  return {
    staleDays: curatorSettings.staleDays,
    minViewsBeforeArchive: curatorSettings.minViewsBeforeArchive,
    maxArchivePerRun: curatorSettings.maxArchivePerRun,
    enableLlmPhase: curatorSettings.enableLlmPhase,
  };
}

function curatorDeps() {
  return {
    isKillSwitchActive: () => killSwitchActive,
    callModel: async (prompt: string): Promise<string> => {
      const model = summarizerModel || currentModel;
      if (!model) throw new Error('No model configured for curator LLM phase');
      const client = webRuntime.createClient(model, ollamaHost);
      const response = await client.chat([{ role: 'user', content: prompt }]);
      return response.message?.content ?? '';
    },
  };
}

function configureCuratorScheduler(): void {
  if (curatorScheduler) {
    curatorScheduler.stop();
    curatorScheduler = null;
  }
  if (!curatorSettings.enabled) return;
  curatorScheduler = new CuratorScheduler({
    projectDir: PROJECT_DIR,
    config: curatorConfigFromSettings(),
    intervalHours: curatorSettings.intervalHours,
    idleThresholdMinutes: curatorSettings.idleThresholdMinutes,
    isKillSwitchActive: () => killSwitchActive,
    isEnabled: () => curatorSettings.enabled,
    getLastUserActivityMs: () => lastUserActivityMs,
    getLastRunMs: () => curatorSettings.lastRunAt ? Date.parse(curatorSettings.lastRunAt) || 0 : 0,
    recordRunMs: (timestamp) => {
      curatorSettings = { ...curatorSettings, lastRunAt: new Date(timestamp).toISOString() };
      saveSettingsToDisk().catch(() => {});
    },
    callModel: curatorDeps().callModel,
  });
  curatorScheduler.start();
}

export function stopCuratorScheduler(): void {
  if (curatorScheduler) {
    curatorScheduler.stop();
    curatorScheduler = null;
  }
}

// --- API: File Tree ---
app.get('/api/files', async (req, res) => {
  const dir = resolveProjectPath((req.query.path as string) || PROJECT_DIR);
  if (!dir) { res.status(400).json({ error: 'Path is outside the project directory.' }); return; }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .map(e => {
        const absolute = path.join(dir, e.name);
        const relative = path.relative(PROJECT_DIR, absolute).split(path.sep).join('/');
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: absolute, relative };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ items, cwd: dir, projectDir: PROJECT_DIR });
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
    modelCatalog,
    extensionActivation,
    walkthrough,
    curator: curatorSettings,
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
    if (parsedHost) { ollamaHost = parsedHost; setRagRuntime({ ollamaHost }); }
  }
  if (settings.systemPrompt !== undefined) systemPromptOverride = String(settings.systemPrompt).slice(0, 20_000);
  if (settings.summarizerModel !== undefined) summarizerModel = sanitizeModelName(settings.summarizerModel);
  if (settings.modelRouting !== undefined) modelRouting = sanitizeModelRoutingPolicy(settings.modelRouting);
  if (settings.mediaTools !== undefined) {
    mediaTools = sanitizeMediaToolSettings(settings.mediaTools);
    applyMediaToolEnvironment(mediaTools);
    configureUploadsAutoPrune();
  }
  if (settings.outputValidation !== undefined) outputValidation = sanitizeOutputValidationSettings(settings.outputValidation);
  if (settings.modelCatalog !== undefined) modelCatalog = sanitizeModelCatalogSettings(settings.modelCatalog);
  if (settings.extensionActivation !== undefined) extensionActivation = sanitizeExtensionActivationSettings(settings.extensionActivation);
  if (settings.walkthrough !== undefined) walkthrough = sanitizeWalkthroughSettings(settings.walkthrough);
  if (settings.curator !== undefined) {
    curatorSettings = sanitizeCuratorSettings(settings.curator);
    configureCuratorScheduler();
  }
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
  const autoPruneDays = Number.isFinite(Number(source.uploadsAutoPruneDays)) ? clampNumber(source.uploadsAutoPruneDays, 0, 3650, 0) : 0;
  return {
    visionModel: sanitizeModelName(source.visionModel).slice(0, 200),
    audioTranscribeCommand: String(source.audioTranscribeCommand ?? '').trim().slice(0, 5000),
    pdfOcrCommand: String(source.pdfOcrCommand ?? '').trim().slice(0, 5000),
    uploadsDir: String(source.uploadsDir ?? '').trim().slice(0, 1000),
    uploadsAutoPruneDays: Math.floor(autoPruneDays),
    uploadsLastPrunedAt: String(source.uploadsLastPrunedAt ?? '').trim().slice(0, 64),
  };
}

function sanitizeOutputValidationSettings(value: unknown): OutputValidationSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const profile = parseOutputValidationProfile(source.profile, customOutputValidationProfiles) ?? 'oracle-prime';
  return { enabled: source.enabled === true, profile, autoSelect: source.autoSelect !== false, skipOnLowSignal: source.skipOnLowSignal === true };
}

function effectiveOutputValidationForMessage(message: string): EffectiveOutputValidationSettings {
  if (!outputValidation.enabled || !outputValidation.autoSelect) {
    return { ...outputValidation, selectionSource: 'manual-selected', selectionReason: 'Manual profile override is active.' };
  }
  // Use a neutral fallback so vague or short prompts do not inherit a sticky stored profile (e.g. coding-answer).
  const suggestion = describeOutputValidationProfileSuggestion(message, 'oracle-prime');
  if (!suggestion.matched && outputValidation.skipOnLowSignal) {
    return { ...outputValidation, enabled: false, profile: suggestion.profile, selectionSource: 'auto-selected', selectionReason: 'No strong signal in the prompt; validation skipped (skip-on-low-signal is on).' };
  }
  return { ...outputValidation, profile: suggestion.profile, selectionSource: 'auto-selected', selectionReason: suggestionReason(suggestion.profile, suggestion.matched) };
}

function suggestionReason(profile: OutputValidationProfile, matched = true): string {
  if (!matched) return `No strong signal in the prompt; defaulted to ${profile}.`;
  switch (profile) {
    case 'coding-answer': return 'The prompt looks like code, tests, files, or implementation work.';
    case 'factual-answer': return 'The prompt looks like a current or factual answer that should cite evidence and uncertainty.';
    case 'tool-result-summary': return 'The prompt looks like a command, terminal, log, or tool output summary.';
    case 'oracle-prime': return 'The prompt looks like a decision, risk, strategy, or uncertainty-heavy answer.';
    default: return 'Using the current custom profile because it is selected manually.';
  }
}

function sanitizeModelCatalogSettings(value: unknown): ModelCatalogSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const parsedUrl = source.url === undefined || String(source.url).trim() === '' ? '' : parseHttpUrl(source.url) ?? '';
  return {
    url: parsedUrl.slice(0, 1000),
    ttlHours: Math.floor(clampNumber(source.ttlHours, 1, 24 * 30, 24)),
  };
}

function sanitizeExtensionActivationSettings(value: unknown): ExtensionActivationSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const allowedPluginNames = Array.isArray(source.allowedPluginNames)
    ? Array.from(new Set(source.allowedPluginNames.map((item) => sanitizeModelName(item)).filter((item) => item && SAFE_ID_PATTERN.test(item))))
    : [];
  return {
    executablePlugins: source.executablePlugins === true,
    allowedPluginNames,
    requirePermissionReview: source.requirePermissionReview !== false,
  };
}

function describeExtensionActivation(kind: string, name: string, manifestEnabled: boolean): { status: 'ready' | 'blocked' | 'inactive'; reason: string } {
  if (kind === 'skill') return { status: 'ready', reason: 'Skill metadata is active when its trigger matches.' };
  if (!manifestEnabled) return { status: 'inactive', reason: 'Plugin manifest is disabled.' };
  if (!extensionActivation.executablePlugins) return { status: 'blocked', reason: 'Executable plugin activation is disabled by policy.' };
  if (!extensionActivation.allowedPluginNames.includes(name)) return { status: 'blocked', reason: 'Plugin is not in the allowed activation list.' };
  if (extensionActivation.requirePermissionReview) return { status: 'blocked', reason: 'Permission review is required before executable activation.' };
  return { status: 'ready', reason: 'Policy allows activation, but runtime plugin execution is not implemented in this build.' };
}

async function fetchJsonFromUrl(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Catalog fetch failed: HTTP ${response.status}`);
  return response.json();
}

function sanitizeWalkthroughSettings(value: unknown): WalkthroughSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const allowed = new Set(['setup', 'validation', 'learning', 'about']);
  const completed = Array.isArray(source.completed)
    ? Array.from(new Set(source.completed.map((item) => String(item)).filter((item) => allowed.has(item))))
    : [];
  return { completed };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeCuratorSettings(value: unknown): CuratorSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    enabled: Boolean(source.enabled),
    intervalHours: clampInt(source.intervalHours, 1, 24 * 365, 168),
    idleThresholdMinutes: clampInt(source.idleThresholdMinutes, 1, 24 * 60, 120),
    staleDays: clampInt(source.staleDays, 1, 3650, 60),
    minViewsBeforeArchive: clampInt(source.minViewsBeforeArchive, 0, 1_000_000, 1),
    maxArchivePerRun: clampInt(source.maxArchivePerRun, 1, 100, 5),
    enableLlmPhase: Boolean(source.enableLlmPhase),
    lastRunAt: typeof source.lastRunAt === 'string' ? source.lastRunAt : '',
  };
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
  if (settings.pdfOcrCommand) process.env.HARNESS_PDF_OCR_COMMAND = settings.pdfOcrCommand;
  else delete process.env.HARNESS_PDF_OCR_COMMAND;
  if (settings.uploadsDir) process.env.HARNESS_UPLOADS_DIR = settings.uploadsDir;
  else delete process.env.HARNESS_UPLOADS_DIR;
}

function withRoutingPolicy(prompt: string): string {
  const entries = Object.entries(modelRouting).filter(([, value]) => value !== undefined && value !== '');
  if (entries.length === 0) return prompt;
  return prompt + '\n\n--- Helper Model Routing Policy ---\n' + entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

async function buildAttachmentsContextBlock(raw: unknown): Promise<string | null> {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const uploadsDir = getUploadsDir();
  const lines: string[] = [];
  for (const entry of raw.slice(0, 20)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : null;
    if (!name) continue;
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeName) continue;
    const absolute = path.join(uploadsDir, safeName);
    let exists = false;
    let size = 0;
    try {
      const stat = await fs.stat(absolute);
      exists = stat.isFile();
      size = stat.size;
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const cwdRel = path.relative(PROJECT_DIR, absolute);
    const display = cwdRel.startsWith('..') ? absolute : cwdRel;
    const rel = display.split(path.sep).join('/');
    const kind = typeof (entry as { mediaKind?: unknown }).mediaKind === 'string' ? (entry as { mediaKind: string }).mediaKind : 'file';
    lines.push(`- ${kind}: name="${safeName}" path="${rel}" size=${size}`);
  }
  if (lines.length === 0) return null;
  return [
    '--- Session Attachments (authoritative) ---',
    'The user attached the following files via the Harness UI. These paths are exact and verified by the harness.',
    'Always pass the exact "path" string to file_read, pdf_read, image_analyze, or audio_transcribe — never strip the .harness/uploads/ prefix and never pass only the bare filename.',
    'You may also call list_uploads at any time to re-list every available attachment.',
    ...lines,
  ].join('\n');
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

async function getAboutInfo(): Promise<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string; manifestName: string; manifestUrl: string }> {
  const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_DIR, 'package.json'), 'utf-8')) as { version?: string };
  const provenance = await readReleaseProvenance();
  const version = packageJson.version ?? provenance.version ?? 'unknown';
  const releaseUrl = provenance.releaseUrl ?? `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v${version}`;
  const manifestName = provenance.manifestName ?? `ollama-agent-harness-v${version}.zip.sha256.json`;
  return {
    version,
    commit: provenance.commit ?? process.env.GITHUB_SHA ?? '',
    assetName: provenance.assetName ?? `ollama-agent-harness-v${version}.zip`,
    assetSha256: provenance.assetSha256 ?? '',
    releaseUrl,
    generatedAt: provenance.generatedAt ?? '',
    manifestName,
    manifestUrl: releaseUrl && manifestName ? `${releaseUrl.replace(/\/tag\/[^/]+$/, `/download/v${version}`)}/${manifestName}` : '',
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

async function readReleaseProvenance(): Promise<Partial<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string; manifestName: string }>> {
  let provenance: Partial<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string; manifestName: string }> = {};
  try {
    provenance = JSON.parse(await fs.readFile(RELEASE_PROVENANCE_PATH, 'utf-8')) as Partial<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string; manifestName: string }>;
  } catch {
    provenance = {};
  }
  const manifest = await readReleaseManifest(provenance.assetName);
  return { ...provenance, ...manifest };
}

async function readReleaseManifest(assetName?: string): Promise<Partial<{ assetName: string; assetSha256: string; generatedAt: string; manifestName: string }>> {
  const candidates = [
    path.join(PROJECT_DIR, 'release-manifest.json'),
    assetName ? path.join(PROJECT_DIR, 'release', `${assetName}.sha256.json`) : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf-8')) as Partial<{ assetName: string; assetSha256: string; generatedAt: string; manifestName: string }>;
    } catch {
      // Try the next companion manifest location.
    }
  }
  return {};
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
