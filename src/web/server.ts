import express from 'express';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { watch as fsWatch } from 'fs';
import * as net from 'net';
import * as crypto from 'crypto';
import * as os from 'os';
import { once } from 'events';
import { Ollama } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import { createChatClient, OPENAI_COMPATIBLE_PRESETS, REPLICATE_PRESET, readApiKey } from '../core/chatClientFactory';
import { drainRemoteProviderFallbackEvents } from '../core/fallbackChatClient';
import type { IChatClient } from '../core/chatClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { createBuiltinToolRegistry } from '../tools/registry';
import { WorkflowRegistry } from '../workflows/workflowRegistry';
import { runCurator, runDeterministicPhase, readCuratorLog, readCuratorProposals, restoreSkill, parseMergeProposals, applyMergeProposal, clearCuratorProposals, type CuratorConfig } from '../curator/curator';
import { CuratorScheduler } from '../curator/scheduler';
import { listSkillUsage, recordSkillUse, recordSkillView, setSkillPinned } from '../extensibility/skillUsage';
import { clearFileWriteRedirectCache, drainUploadsFallbacks, getAllowedExternalPaths, getFileWriteRedirects, getUploadsDir, previewFileWriteRedirect, resolveProjectReadPath, setAllowedExternalPaths } from '../tools/pathResolution';
import { iteratePdfPages, MAX_PDF_BYTES } from '../tools/pdfTool';
import { invalidateSkillsCache, setSkillsDir } from '../tools/skillTools';
import { setRagRuntime } from '../tools/ragTools';
import { setCuratorToolRuntime } from '../tools/curatorTools';
import { PermissionEngine } from '../permissions/engine';
import { PermissionPromptBroker } from '../permissions/promptBroker';
import { createCapabilityGrant, evaluateCapabilityGrant, findExpiredGrants, listActiveCapabilityGrants, listCapabilityPolicies, mapToolsToCapabilityCoverage, revokeCapabilityGrant, sanitizeCapabilityGrants, summarizeCapabilityAlignment, autoGrantGatedCapabilities, type CapabilityGrant } from '../permissions/capabilities';
import { SessionStorage } from '../persistence/sessionStorage';
import { forkSession, resumeSession } from '../persistence/resume';
import { buildMemoryPalace, getSemanticMemoryContext, getSemanticMemoryEntry, rebuildSemanticMemory, searchSemanticMemory } from '../persistence/semanticMemory';
import * as snapshots from '../persistence/snapshots';
import * as ragIndex from '../persistence/ragIndex';
import { MCP_CATALOG } from '../extensibility/mcpCatalog';
import { listMcpServers, removeMcpServer, startMcpServer, stopMcpServer, upsertMcpServer } from '../extensibility/mcpRuntime';
import { assembleSystemContext, estimateTokenCount } from '../context/assembly';
import { HookPipeline } from '../extensibility/hookPipeline';
import { loadSkillsDir, matchSkillTrigger, scanSkillsDir, type SkillDefinition, type SkillDirectoryScan } from '../extensibility/skillLoader';
import { discoverExtensionManifests } from '../extensibility/extensionManifest';
import { RateLimiter } from '../core/rateLimiter';
import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { OUTPUT_VALIDATION_PROFILES, OUTPUT_VALIDATION_PROFILE_TEMPLATES, describeOutputValidationProfileSuggestion, normalizeCustomOutputValidationProfiles, parseOutputValidationProfile, validateCustomOutputValidationProfiles, validateOutput, type CustomOutputValidationProfile, type OutputValidationProfile } from '../core/outputValidation';
import { loadSynthesisStats, recordSynthesisFired, recordSessionCompleted, adaptiveMaxTurns, adaptiveTimeBudget, recordAvgTurnDuration, clearSynthesisStats } from '../core/synthesisStats';
import { startNewSession, onSessionEnd, getEvolvedPrompt, recordSessionAutoContinue } from '../learning/engine';
import { appendEvalTraceExample, createEvalTraceExample, createOutputValidationTrendExport, createReplayEvalExample, deleteEvalTraceExample, listEvalTraceExamples, listEvalTraceRuns, readEvalTraceDataset, recordContextLossEvalRun, recordOutputValidationEvalRun, recordProfileFeedbackEvalRun, recordUploadsFallbackEvalRun, runEvalTraceDataset, summarizeContextLossRuns, summarizeEvalTraceRuns, summarizeOutputValidationRuns, summarizeProfileFeedbackRuns, summarizeUploadsFallbackRuns, updateEvalTraceExampleTags } from '../learning/evalTrace';
import { appendLearningCandidate, extractLearningCandidate, getLearningCandidateProvenance, listReviewedLearningCandidates, reviewLearningCandidate } from '../learning/sessionLearning';
import { listSubagentRoutingMetrics } from '../agents/subagent';
import { calibrateModelRoutingPolicy, summarizeRoutingMetrics } from '../agents/modelRouting';
import { checkSetupHealth } from '../setup/health';
import { getModelCatalog, getModelCatalogCacheStatus } from '../models/modelCatalog';
import { isVisionCapableModelName } from '../models/visionModels';
import { createAutomationJob, deleteAutomationJob, executeDueJobs, listAutomationJobs, listDueAutomationJobs, readAutomationRunLog, updateAutomationJob } from '../automation/jobs';
import { prepareAutomationRun } from '../automation/runner';
import { AutomationScheduler } from '../automation/scheduler';
import { exportAgenticServices, getAgenticService, handleOperateModeRequest, importAgenticServices, listAgenticServices } from '../services/agenticServiceMode';
import { classifyMode } from '../services/modeClassifier';
import { createDefaultCapabilityRegistry, type CapabilityRegistry } from '../services/capabilityRegistry';
import { WorkerQueue } from '../services/workerQueue';
import { createPromise, listPromises, updatePromise, checkObligations, fulfilPromise, failPromise, detectCommitments, type PromiseStatus } from '../services/promiseLedger';
import { getServiceLifecycle, initServiceLifecycle, transitionService, probeServiceHealth, SERVICE_TEMPLATES, type ServiceLifecycleStatus } from '../services/serviceLifecycle';
import { appendEvent, emitEvent, queryEvents, summarizeEventStore, generatePostmortem, createSnapshot, getSnapshot, listSnapshots, type EventCategory } from '../persistence/eventStore';
import { subscribeEventStream } from '../persistence/eventStore';
import { verifyCode, verifyService, verifyPromiseFulfillability } from '../core/doneStateVerifier';
import { tryDeterministicShortcut } from '../core/deterministicShortcuts';
import { calculateReadiness, type ReadinessInput } from '../core/readinessGate';
import { validateStructuredOutput, parseAndValidate, detectSchema, BUILTIN_SCHEMAS } from '../core/structuredOutputValidator';
import { buildRepoGraph, analyzeImpact, summarizeRepo, saveRepoGraph, loadRepoGraph } from '../core/codeIntelligence';
import { createMycelialRouter, type MycelialContextRouter } from '../mycelium/router';
import { heuristicVerifier } from '../mycelium/verifier';
import { seedCodeIntelligence } from '../mycelium/seeds';
import { getSessionSearchIndexStatus, rebuildSessionSearchIndexWithMetadata } from '../persistence/sessionSearchIndex';
import { appendRunEvidence, readRunEvidence, type StoredRunEvidence } from '../persistence/evidenceStore';
import { startTelegramBot, stopTelegramBot, isTelegramBotRunning, sendTelegramNotification, loadPersistedChatIds, getTelegramPollingLockInfo } from '../integrations/telegram';
import { startDiscordBot, stopDiscordBot, isDiscordBotRunning } from '../integrations/discord';
import { addWebhook, removeWebhook, listWebhooks, loadWebhooksFromEnv, sendWebhookNotification } from '../integrations/webhooks';
import { NervousSystemController } from '../nervous';
import { listShellCommandAllowlistPresets } from '../automation/runner';
import { appendCapabilityAuditEvent, readCapabilityAuditEvents } from '../permissions/capabilityAudit';
import type { ModelRoutingPolicy } from '../agents/modelRouting';
import type { LoopConfig, LoopEvent, PermissionMode, Tool } from '../types';
import type { EvidenceCard, EvidenceFileSummary, EvidenceMode, EvidenceToolSummary } from '../types/evidence';
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
const DOCUMENTS_DIR = path.join(PROJECT_DIR, '.harness', 'documents');
const SETTINGS_PATH = path.join(PROJECT_DIR, '.harness', 'settings.json');
const API_KEYS_PATH = path.join(PROJECT_DIR, '.harness', 'api-keys.json');
const FILE_REDIRECTS_PATH = path.join(PROJECT_DIR, '.harness', 'file-write-redirects.json');
const OUTPUT_VALIDATION_PROFILES_PATH = path.join(PROJECT_DIR, '.harness', 'output-validation-profiles.json');
const RELEASE_PROVENANCE_PATH = path.join(PROJECT_DIR, 'release-provenance.json');
const WORKFLOWS_DIR = path.join(PROJECT_DIR, '.harness', 'workflows');
const workflowRegistry = new WorkflowRegistry(WORKFLOWS_DIR);
const ALLOWED_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'dontAsk'];
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
let autonomyChild: ChildProcessWithoutNullStreams | null = null;
let autonomyStartedAt: string | undefined;
const globalNervousSystem = new NervousSystemController();

type QueryLoopRunner = (config: LoopConfig, deps: QueryLoopDeps, initialMessages: Message[]) => AsyncGenerator<LoopEvent>;

interface WebSettings {
  model: string;
  permissionMode: PermissionMode;
  ollamaHost: string;
  systemPrompt: string;
  agentPersonality: string;
  agentName: string;
  agentAvatar: string;
  agentProfiles: Record<string, { name: string; avatar: string; personality: string; model: string }>;
  summarizerModel: string;
  contextMaxTokens: number;
  timeBudgetMs: number;
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
  automationScheduler: AutomationSchedulerSettings;
  /** Tool names disabled via the Tools tab. Restored on startup. */
  disabledTools: string[];
  /** Time-limited tool enables: tool name → ISO expiry timestamp. */
  timedToolEnables: Record<string, string>;
  /** ISO timestamp when timed autonomy expires and permissionMode reverts. */
  autonomyExpiresAt: string;
  /** Permission mode to revert to when timed autonomy expires. */
  autonomyPreviousMode: PermissionMode;
  /** Last known kill switch state. Restored on startup so a stop persists across restarts. */
  killSwitch: { active: boolean; reason: string };
  /** Time-limited capability grants for gated high-power surfaces. */
  capabilityGrants: CapabilityGrant[];
  allowedExternalPaths: string[];
  /** User-set folder where new agent file_write outputs go. Empty string
   * means use the default <project>/agent-outputs. Persisted to settings
   * AND mirrored into HARNESS_AGENT_OUTPUT_DIR so the file_write tool
   * picks it up on the next call. */
  agentOutputDir: string;
  /** Telegram bot token for the /api/chat bridge. Set via Settings or HARNESS_TELEGRAM_BOT_TOKEN env. */
  telegramBotToken: string;
  /** Comma-separated Telegram chat IDs allowed to use the bot. Empty = any. */
  telegramAllowedChatIds: string;
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

interface AutomationSchedulerSettings {
  enabled: boolean;
  idleThresholdMinutes: number;
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
  createClient(model: string, host: string, numCtx?: number): IChatClient;
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
let agentPersonality = '';
let agentName = '';
let agentAvatar = '';
let agentProfiles: Record<string, { name: string; avatar: string; personality: string; model: string }> = {};
let summarizerModel = '';
const DEFAULT_CONTEXT_MAX_TOKENS = 8192;
let contextMaxTokens = DEFAULT_CONTEXT_MAX_TOKENS;
let detectedContextMaxTokens: number | null = null;
let timeBudgetMs = 0; // 0 = auto-detect (180s local, 600s cloud)
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
// Simple "put all agent files here" override. Empty string means use the
// built-in default (<project>/agent-outputs). Mirrored into the env var
// HARNESS_AGENT_OUTPUT_DIR on every change so getAgentOutputDir() picks it up.
let agentOutputDir: string = process.env.HARNESS_AGENT_OUTPUT_DIR ?? '';
let telegramBotToken: string = process.env.HARNESS_TELEGRAM_BOT_TOKEN ?? '';
let telegramAllowedChatIds: string = process.env.HARNESS_TELEGRAM_ALLOWED_CHAT_IDS ?? '';
let discordBotToken: string = process.env.HARNESS_DISCORD_BOT_TOKEN ?? '';
let discordAllowedChannelIds: string = process.env.HARNESS_DISCORD_ALLOWED_CHANNEL_IDS ?? '';
let outputValidation: OutputValidationSettings = { enabled: false, profile: 'oracle-prime', autoSelect: true, skipOnLowSignal: true };
let customOutputValidationProfiles: CustomOutputValidationProfile[] = [];
let modelCatalog: ModelCatalogSettings = { url: '', ttlHours: 24 };
let extensionActivation: ExtensionActivationSettings = { executablePlugins: false, allowedPluginNames: [], requirePermissionReview: true };
let walkthrough: WalkthroughSettings = { completed: [] };
let settingsLoaded = false;
let killSwitchActive = false;
let killSwitchReason = '';
const disabledTools = new Set<string>();
/** Time-limited tool enables: tool name → expiry timestamp (ms). */
const timedToolEnables = new Map<string, number>();
/** Timed autonomy: when set, permissionMode reverts to autonomyPreviousMode after this timestamp. */
let autonomyExpiresAt = 0;
let autonomyPreviousMode: PermissionMode = 'default';
let capabilityGrants: CapabilityGrant[] = [];

function getAutomationPolicyContext(now = new Date()): { grants: CapabilityGrant[]; killSwitchActive: boolean; now: Date } {
  return { grants: listActiveCapabilityGrants(capabilityGrants, now), killSwitchActive, now };
}

let curatorSettings: CuratorSettings = sanitizeCuratorSettings({});
let automationSchedulerSettings: AutomationSchedulerSettings = sanitizeAutomationSchedulerSettings({});
let lastUserActivityMs = Date.now();
let curatorScheduler: CuratorScheduler | null = null;
let automationScheduler: AutomationScheduler | null = null;

/** Check whether a tool is effectively enabled right now, considering timed enables. */
function isToolEnabled(name: string): boolean {
  if (!disabledTools.has(name)) return true;
  const expiry = timedToolEnables.get(name);
  if (expiry !== undefined) {
    if (Date.now() < expiry) return true;
    // Expired — clean up
    timedToolEnables.delete(name);
    saveSettingsToDisk().catch(() => {});
  }
  return false;
}

/** Check and revert timed autonomy if expired. */
function checkAutonomyExpiry(): void {
  if (autonomyExpiresAt > 0 && Date.now() >= autonomyExpiresAt) {
    const prev = autonomyPreviousMode;
    logger.info('Permissions', 'Timed autonomy expired, reverting to ' + prev);
    appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.expired', reason: `Expired, reverted to ${prev}` }).catch(() => {});
    permissionMode = prev;
    autonomyExpiresAt = 0;
    autonomyPreviousMode = 'default';
    saveSettingsToDisk().catch(() => {});
  }
}

function formatMinutesRemaining(expiresAtMs: number): string {
  const ms = expiresAtMs - Date.now();
  if (ms <= 0) return '0m';
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function applyToolDisables(tools: Tool[]): Tool[] {
  if (disabledTools.size === 0 && timedToolEnables.size === 0) return tools;
  return tools.filter((tool) => isToolEnabled(tool.name));
}

function hasDryRunIntent(input: Record<string, unknown>): boolean {
  return input.dryRun === true || input.dry_run === true || input.preview === true;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] ?? '').trim());
}

function shouldBypassNervousVerification(): boolean {
  if (envFlag('HARNESS_NERVOUS_ALLOW_UNVERIFIED')) return true;
  return permissionMode === 'dontAsk';
}

const rateLimiter = new RateLimiter(10, 2);
const hookPipeline = new HookPipeline();
const permissionPrompts = new PermissionPromptBroker();
const capabilityRegistry: CapabilityRegistry = createDefaultCapabilityRegistry();
const defaultWebRuntime: WebRuntimeDeps = {
  createClient: (model, host, numCtx) => {
    // Model id may be backend-prefixed: "mistral/mistral-medium-latest"
    // dispatches to the Mistral preset; bare names route to Ollama.
    const slash = model.indexOf('/');
    if (slash > 0) {
      const backend = model.slice(0, slash).toLowerCase();
      const realModel = model.slice(slash + 1);
      if (OPENAI_COMPATIBLE_PRESETS[backend]) {
        return createChatClient({ backend, model: realModel, host, numCtx });
      }
    }
    return new OllamaClient({ model, host, numCtx });
  },
  getModelContextWindow: (model, host) => {
    const slash = model.indexOf('/');
    if (slash > 0 && OPENAI_COMPATIBLE_PRESETS[model.slice(0, slash).toLowerCase()]) {
      // OpenAI-compatible backends: use a generous default; the harness
      // lets the model itself enforce its real context window.
      return Promise.resolve(128_000);
    }
    return new OllamaClient({ model, host }).getContextWindow();
  },
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

type SkillApiSource = 'runtime' | 'repo';

function skillFolderId(skill: SkillDefinition): string {
  return path.basename(path.dirname(skill.filePath));
}

function mapSkillForApi(source: SkillApiSource): (skill: SkillDefinition) => Record<string, unknown> {
  return (skill) => ({
    id: skillFolderId(skill),
    name: skill.name,
    description: skill.description,
    domain: skill.domain,
    triggers: skill.triggers,
    filePath: skill.filePath,
    source,
  });
}

function skillSourceForApi(source: SkillApiSource, label: string, directory: string, scan: SkillDirectoryScan, mutable: boolean): Record<string, unknown> {
  return {
    source,
    label,
    directory,
    skills: scan.skills.map(mapSkillForApi(source)),
    diagnostics: scan.diagnostics,
    mutable,
  };
}

// Initialize skills directory for SkillTool
setSkillsDir(SKILLS_DIR);
setRagRuntime({ projectDir: PROJECT_DIR, ollamaHost });
setCuratorToolRuntime({
  projectDir: PROJECT_DIR,
  getConfig: () => curatorConfigFromSettings(),
  isKillSwitchActive: () => killSwitchActive,
});

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

// Surface the autonomy loop's checkpoint so the UI can show a live progress
// banner. Returns 204 when no autonomy run has occurred (file absent), 200
// with the parsed checkpoint otherwise. Read-only; never blocks on disk.
app.get('/api/autonomy/state', async (_req, res) => {
  const statePath = path.join(process.cwd(), '.forge-state.json');
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(204).end();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

/**
 * Server-Sent Events stream of autonomy checkpoint updates. Replaces the
 * UI's prior 3-second polling loop on /api/autonomy/state with push-based
 * delivery. Emits an event whenever .forge-state.json changes, plus an
 * initial snapshot on connect and a heartbeat every 25s to defeat
 * intermediate idle-connection timeouts.
 *
 * Event format (matches EventSource defaults):
 *   data: { ...checkpoint }
 *   data: null  (when state file is absent or unreadable)
 */
app.get('/api/autonomy/state/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const statePath = path.join(process.cwd(), '.forge-state.json');

  const sendSnapshot = async (): Promise<void> => {
    try {
      const raw = await fs.readFile(statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.write('data: null\n\n');
      } else {
        // Don't kill the stream on a transient read error — log and move on.
        const msg = error instanceof Error ? error.message : String(error);
        res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
      }
    }
  };

  // Initial snapshot.
  void sendSnapshot();

  // Watch the parent directory because watching a file directly is
  // unreliable across platforms (Windows requires the file to exist;
  // editor save-and-replace breaks file-targeted watchers). A short
  // debounce coalesces save bursts.
  let debounce: NodeJS.Timeout | null = null;
  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(process.cwd(), (_event, filename) => {
      if (!filename || filename.toString() !== '.forge-state.json') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void sendSnapshot(); }, 100);
    });
  } catch {
    // Best-effort; if watching the cwd fails fall back to keepalive only.
  }

  // Heartbeat every 25s to keep proxies / browsers from idling out.
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);

  // Use res.on('close') (NOT req.on('close')) to detect client disconnect
  // on long-lived SSE responses — req-close fires too early on some
  // node versions.
  res.on('close', () => {
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
  });
});

// Tail the autonomy loop log (.forge-run.log). `?lines=N` selects how many
// trailing lines to return (default 50, max 500). Returns 204 when no log
// exists yet so the UI can hide the panel without surfacing an error.
app.get('/api/autonomy/log', async (req, res) => {
  const logPath = path.join(process.cwd(), '.forge-run.log');
  const requested = parseInt(String(req.query.lines ?? '50'), 10);
  const lineCount = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 50;
  try {
    const raw = await fs.readFile(logPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    res.json({ lines: lines.slice(-lineCount), total: lines.length });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(204).end();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Return the autonomy iteration history (.forge-history.jsonl) as a parsed
// array. `?limit=N` returns the most recent N entries (default 100, max
// 1000). Returns 204 when no history exists yet. Malformed lines are
// skipped, not surfaced as errors, since the file is append-only and a
// half-written tail is recoverable on the next iteration.
app.get('/api/autonomy/history', async (req, res) => {
  const historyPath = path.join(process.cwd(), '.forge-history.jsonl');
  const requested = parseInt(String(req.query.limit ?? '100'), 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 1000) : 100;
  try {
    const raw = await fs.readFile(historyPath, 'utf-8');
    const entries: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    res.json({ entries: entries.slice(-limit), total: entries.length });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(204).end();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

interface PlanPreviewTask {
  id: string;
  title: string;
  status: 'pending' | 'done' | 'failed';
  anchors: string[];
  target?: string;
}

async function readAutonomyPlanPreview(planPath = path.join(PROJECT_DIR, 'IMPLEMENTATION_PLAN.md')): Promise<{ tasks: PlanPreviewTask[]; total: number; pending: number; done: number; failed: number }> {
  const raw = await fs.readFile(planPath, 'utf-8');
  const tasks: PlanPreviewTask[] = [];
  let current: PlanPreviewTask | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const taskMatch = line.match(/^- \[(.)\] (\S+)\s*[—\-]\s*(.+)$/);
    if (taskMatch) {
      const marker = taskMatch[1];
      current = {
        id: taskMatch[2],
        title: taskMatch[3].trim(),
        status: marker === 'x' ? 'done' : marker === '!' ? 'failed' : 'pending',
        anchors: [],
      };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const anchorMatch = line.match(/^\s+- anchor:\s*(\S+)\s*$/);
    if (anchorMatch) current.anchors.push(anchorMatch[1]);
    const targetMatch = line.match(/^\s+- target:\s*(\S+)\s*$/);
    if (targetMatch) current.target = targetMatch[1];
  }
  return {
    tasks,
    total: tasks.length,
    pending: tasks.filter((task) => task.status === 'pending').length,
    done: tasks.filter((task) => task.status === 'done').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
  };
}

app.get('/api/autonomy/plan-preview', async (_req, res) => {
  try {
    res.json({ planPath: 'IMPLEMENTATION_PLAN.md', ...(await readAutonomyPlanPreview()) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/autonomy/tasks', async (req, res) => {
  try {
    const title = String(req.body?.title ?? '').trim();
    if (!title) { res.status(400).json({ error: 'Task title is required.' }); return; }
    const description = String(req.body?.description ?? title).trim();
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `task-${Date.now()}`;
    const planPath = path.join(PROJECT_DIR, 'IMPLEMENTATION_PLAN.md');
    let existing = '';
    try { existing = await fs.readFile(planPath, 'utf-8'); } catch { existing = '# Implementation Plan\n'; }
    const entry = `\n- [ ] ${id} — ${description}\n`;
    await fs.writeFile(planPath, existing.replace(/\n*$/, '') + entry, 'utf-8');
    const preview = await readAutonomyPlanPreview();
    res.json({ ok: true, id, title: description, ...preview });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/autonomy/tasks/:id/complete', async (req, res) => {
  try {
    const taskId = String(req.params.id ?? '').trim();
    if (!taskId) { res.status(400).json({ error: 'Task id is required.' }); return; }
    const planPath = path.join(PROJECT_DIR, 'IMPLEMENTATION_PLAN.md');
    const raw = await fs.readFile(planPath, 'utf-8');
    const updated = raw.replace(new RegExp(`^(- \\[) \\] ${escapeRegex(taskId)}`, 'm'), '$1x] ' + taskId);
    if (updated === raw) { res.status(404).json({ error: 'Task not found.' }); return; }
    await fs.writeFile(planPath, updated, 'utf-8');
    res.json({ ok: true, ...(await readAutonomyPlanPreview()) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/autonomy/tasks/:id', async (req, res) => {
  try {
    const taskId = String(req.params.id ?? '').trim();
    if (!taskId) { res.status(400).json({ error: 'Task id is required.' }); return; }
    const planPath = path.join(PROJECT_DIR, 'IMPLEMENTATION_PLAN.md');
    const raw = await fs.readFile(planPath, 'utf-8');
    // Remove the task line and any indented sub-lines (anchors, targets).
    const pattern = new RegExp(`^- \\[.\\] ${escapeRegex(taskId)}[^\\n]*\\n(?:  - [^\\n]*\\n)*`, 'm');
    const updated = raw.replace(pattern, '');
    if (updated === raw) { res.status(404).json({ error: 'Task not found.' }); return; }
    await fs.writeFile(planPath, updated, 'utf-8');
    res.json({ ok: true, ...(await readAutonomyPlanPreview()) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

app.post('/api/autonomy/dry-run', async (_req, res) => {
  try {
    const preview = await readAutonomyPlanPreview();
    const next = preview.tasks.find((task) => task.status === 'pending');
    res.json({ ok: true, planPath: 'IMPLEMENTATION_PLAN.md', nextTask: next ?? null, ...preview });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/autonomy/start', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    if (killSwitchActive) { res.status(403).json({ error: 'Kill switch is active.' }); return; }
    if (autonomyChild && !autonomyChild.killed) { res.status(409).json({ error: 'An autonomy run is already active.', startedAt: autonomyStartedAt }); return; }
    const preview = await readAutonomyPlanPreview();
    if (preview.pending === 0) { res.status(400).json({ error: 'No pending tasks in IMPLEMENTATION_PLAN.md.' }); return; }
    const preflight = await buildAutonomyPreflight(preview);
    if (preflight.blocked.length > 0) { res.status(409).json({ error: 'Autonomy preflight failed.', preflight }); return; }
    const env = { ...process.env };
    const setEnv = (key: string, value: unknown): void => {
      if (value === undefined || value === null || value === '') return;
      env[key] = String(value);
    };
    setEnv('HARNESS_MODEL', req.body?.model ?? currentModel);
    setEnv('HARNESS_BACKEND', req.body?.backend);
    setEnv('HARNESS_PERMISSION_MODE', req.body?.permissionMode ?? permissionMode);
    setEnv('FORGE_MAX_ITERATIONS', req.body?.maxIterations ?? 1);
    setEnv('HARNESS_TIME_BUDGET_MS', req.body?.timeBudgetMs);
    setEnv('HARNESS_UNPRODUCTIVE_TURN_LIMIT', req.body?.unproductiveTurnLimit ?? 6);
    await fs.rm(path.join(PROJECT_DIR, '.forge-stop'), { force: true }).catch(() => {});
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    autonomyStartedAt = new Date().toISOString();
    autonomyChild = spawn(npmCommand, ['run', 'autonomy'], { cwd: PROJECT_DIR, env });
    const evidence = createRunEvidence({ id: `autonomy:${autonomyStartedAt}`, kind: 'autonomy', request: preview.tasks.find((task) => task.status === 'pending')?.title || 'Run next pending implementation task', runName: 'Ralph autonomy loop', command: 'npm run autonomy', success: true, summary: `Started with ${preview.pending} pending task(s).` });
    await appendRunEvidence(PROJECT_DIR, evidence);
    autonomyChild.on('exit', () => { autonomyChild = null; autonomyStartedAt = undefined; });
    res.json({ ok: true, startedAt: autonomyStartedAt, pid: autonomyChild.pid, pending: preview.pending, evidence });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/autonomy/stop', async (_req, res) => {
  try {
    await fs.writeFile(path.join(PROJECT_DIR, '.forge-stop'), 'stop', 'utf-8');
    if (autonomyChild && !autonomyChild.killed) autonomyChild.kill();
    const evidence = createRunEvidence({ id: `autonomy-stop:${new Date().toISOString()}`, kind: 'autonomy', request: 'Stop active autonomy run', runName: 'Ralph autonomy loop', command: 'write .forge-stop', success: true, summary: 'Stop signal written.' });
    await appendRunEvidence(PROJECT_DIR, evidence);
    res.json({ ok: true, stopped: true, evidence });
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
    let models: Array<{
      name: string;
      size?: number;
      modified?: string | Date;
      family?: string;
      parameterSize?: string;
      capabilities: ReturnType<typeof inferModelCapabilities>;
      backend?: string;
    }> = [];
    try {
      const response = await ollama.list();
      models = response.models.map((m) => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at,
        family: String((m.details as unknown as Record<string, unknown>)?.family ?? ''),
        parameterSize: String((m.details as unknown as Record<string, unknown>)?.parameter_size ?? ''),
        capabilities: inferModelCapabilities(m.name, m.details as unknown as Record<string, unknown>),
        backend: 'ollama',
      }));
    } catch (ollamaErr) {
      // Ollama may be down; still return remote-backend models so the UI
      // is usable for users who only configured cloud keys.
      logger.warn('Models', 'Ollama list failed, returning remote backends only', {
        error: ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr),
      });
    }
    // Append OpenAI-compatible backends whose API keys are configured.
    for (const [backendId, preset] of Object.entries(OPENAI_COMPATIBLE_PRESETS)) {
      if (!readApiKey(preset)) continue;
      const remoteModels = REMOTE_MODEL_CATALOG[backendId] || [];
      for (const m of remoteModels) {
        models.push({
          name: backendId + '/' + m.id,
          parameterSize: m.label,
          capabilities: inferModelCapabilities(m.id, {}),
          backend: backendId,
        });
      }
    }
    if (readApiKey(REPLICATE_PRESET)) {
      for (const m of (REMOTE_MODEL_CATALOG.replicate || [])) {
        models.push({
          name: 'replicate/' + m.id,
          parameterSize: m.label,
          capabilities: inferModelCapabilities(m.id, {}),
          backend: 'replicate',
        });
      }
    }
    res.json({ models });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(503).json({ error: `Failed to list models: ${msg}` });
  }
});

/**
 * Curated catalog of widely-available models per remote backend. The
 * harness does not ship a per-provider model-list call (each provider
 * has its own auth + endpoint shape); instead we expose the most
 * useful defaults and let users type a custom backend/model id directly.
 */
const REMOTE_MODEL_CATALOG: Record<string, Array<{ id: string; label: string }>> = {
  mistral: [
    { id: 'mistral-large-latest', label: 'Mistral Large' },
    { id: 'mistral-medium-latest', label: 'Mistral Medium' },
    { id: 'mistral-medium-3.5', label: 'Mistral Medium 3.5' },
    { id: 'mistral-small-latest', label: 'Mistral Small' },
    { id: 'devstral-small-latest', label: 'Devstral Small' },
    { id: 'devstral-medium-latest', label: 'Devstral Medium' },
    { id: 'codestral-latest', label: 'Codestral' },
    { id: 'pixtral-large-latest', label: 'Pixtral Large' },
    { id: 'open-mistral-nemo', label: 'Mistral Nemo' },
    { id: 'ministral-3b-latest', label: 'Ministral 3B' },
    { id: 'ministral-8b-latest', label: 'Ministral 8B' },
    { id: 'ministral-14b-latest', label: 'Ministral 14B' },
  ],
  cerebras: [
    { id: 'llama3.1-8b', label: 'Llama 3.1 8B' },
    { id: 'llama3.1-70b', label: 'Llama 3.1 70B' },
  ],
  cloudflare: [
    { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' },
    { id: '@cf/meta/llama-3.1-70b-instruct', label: 'Llama 3.1 70B' },
    { id: '@cf/openai/gpt-oss-120b', label: 'GPT OSS 120B' },
  ],
  deepinfra: [
    { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B' },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B' },
    { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B' },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/llama-v3p1-8b-instruct', label: 'Llama 3.1 8B' },
    { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B' },
    { id: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
    { id: 'kimi-k2-instruct', label: 'Kimi K2' },
  ],
  github: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { id: 'Phi-3.5-MoE-instruct', label: 'Phi 3.5 MoE' },
  ],
  openrouter: [
    { id: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash (free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  ],
  huggingface: [
    { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' },
    { id: 'meta-llama/Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B' },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B' },
  ],
  sambanova: [
    { id: 'Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B' },
    { id: 'Meta-Llama-3.1-70B-Instruct', label: 'Llama 3.1 70B' },
    { id: 'DeepSeek-R1', label: 'DeepSeek R1' },
  ],
  together: [
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B' },
    { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B' },
  ],
  replicate: [
    { id: 'meta/meta-llama-3-8b-instruct', label: 'Llama 3 8B' },
    { id: 'meta/meta-llama-3-70b-instruct', label: 'Llama 3 70B' },
  ],
};

// API key management for remote backends. Returns which key NAMES are
// configured (not the values themselves) and whether each comes from
// process env or the .harness/api-keys.json file.
app.get('/api/api-keys', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    let stored: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(API_KEYS_PATH, 'utf-8');
      stored = JSON.parse(raw);
    } catch {}
    const status: Record<string, { configured: boolean; source: 'env' | 'file' | 'none' }> = {};
    for (const name of ALLOWED_API_KEY_NAMES) {
      const envValue = process.env[name];
      const fileValue = stored[name];
      const fromEnv = typeof envValue === 'string' && envValue.trim().length > 0;
      const fromFile = typeof fileValue === 'string' && (fileValue as string).trim().length > 0;
      // Source precedence: 'file' if the value originated from the JSON
      // file (either still file-only or promoted into env by
      // loadStoredApiKeys), otherwise 'env' if shell-exported, otherwise
      // 'none'. This matches what users see in the UI and avoids the
      // 'I entered it in the panel but it shows from env' confusion.
      const sourceIsFile = fromFile || (fromEnv && FILE_SOURCED_KEYS.has(name));
      status[name] = {
        configured: fromEnv || fromFile,
        source: sourceIsFile ? 'file' : (fromEnv ? 'env' : 'none'),
      };
    }
    res.json({ keys: status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Save API keys to .harness/api-keys.json. Empty/whitespace strings
// REMOVE the key from the file. Refuses unknown key names. Loads the
// new values into process.env immediately so subsequent /api/chat
// requests see them without a server restart.
app.post('/api/api-keys', async (req, res) => {
  try {
    const incoming = req.body && typeof req.body === 'object' ? req.body : {};
    let stored: Record<string, string> = {};
    try {
      const raw = await fs.readFile(API_KEYS_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed as Record<string, string>;
    } catch {}
    let changed = false;
    for (const [name, rawValue] of Object.entries(incoming)) {
      if (!ALLOWED_API_KEY_NAMES.has(name)) continue;
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (value) {
        stored[name] = value;
        if (!process.env[name] || !process.env[name]!.trim()) {
          process.env[name] = value;
        }
        // Newly stored via the UI — mark as file-sourced so the GET
        // handler reports 'stored' rather than 'from env' on the next
        // refresh, even though we just populated process.env above.
        FILE_SOURCED_KEYS.add(name);
      } else if (stored[name]) {
        delete stored[name];
        FILE_SOURCED_KEYS.delete(name);
        changed = true;
      }
      changed = true;
    }
    if (changed) {
      await fs.mkdir(path.dirname(API_KEYS_PATH), { recursive: true });
      await fs.writeFile(API_KEYS_PATH, JSON.stringify(stored, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }
    res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// File-write redirect rules. Lets the user route any agent file_write
// whose path matches a glob into a specific directory (typically a
// sibling repo). Solves the recurring "another agent keeps dropping
// lottery scripts in the Harness root" problem at the tool layer
// rather than relying on .gitignore cleanup.
app.get('/api/file-redirects', async (_req, res) => {
  try {
    const { rules, source } = getFileWriteRedirects();
    // Defense in depth: also report whether the env var is set so the
    // UI can show "managed by env var" and disable the editor if so.
    const envOverride = Boolean(process.env.HARNESS_FILE_WRITE_REDIRECTS?.trim());
    res.json({ rules, source, envOverride });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/file-redirects', async (req, res) => {
  try {
    const incoming = req.body && Array.isArray(req.body.rules) ? req.body.rules : null;
    if (!incoming) {
      res.status(400).json({ error: 'Body must be { rules: [...] }' });
      return;
    }
    // Validate + normalize each rule. Skip entries with empty match or
    // empty redirect rather than rejecting the whole payload \u2014 makes
    // the form forgiving when the user is mid-edit.
    const sanitized: Array<{ match: string; redirect: string }> = [];
    for (const entry of incoming) {
      if (!entry || typeof entry !== 'object') continue;
      const match = typeof entry.match === 'string' ? entry.match.trim() : '';
      const redirect = typeof entry.redirect === 'string' ? entry.redirect.trim() : '';
      if (!match || !redirect) continue;
      sanitized.push({ match, redirect });
    }
    await fs.mkdir(path.dirname(FILE_REDIRECTS_PATH), { recursive: true });
    await fs.writeFile(FILE_REDIRECTS_PATH, JSON.stringify(sanitized, null, 2), 'utf-8');
    // Force the in-process cache to reload on the next file_write.
    clearFileWriteRedirectCache();
    res.json({ ok: true, count: sanitized.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Preview endpoint: takes ad-hoc rules + a sample path and returns
// which rule (if any) would catch it and where the file would land.
// Lets the user verify their rules before saving — catches typos like
// `lottery_*` (underscore) when they meant `lottery-*` (hyphen). The
// rules in the body are NOT persisted; this is read-only.
app.post('/api/file-redirects/preview', async (req, res) => {
  try {
    const samplePath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    const rawRules = Array.isArray(req.body?.rules) ? req.body.rules : null;
    if (!samplePath || !rawRules) {
      res.status(400).json({ error: 'Body must be { path: string, rules: [...] }' });
      return;
    }
    // Same sanitization as POST so empty mid-edit rows are skipped here too.
    const rules: Array<{ match: string; redirect: string }> = [];
    for (const entry of rawRules) {
      if (!entry || typeof entry !== 'object') continue;
      const match = typeof entry.match === 'string' ? entry.match.trim() : '';
      const redirect = typeof entry.redirect === 'string' ? entry.redirect.trim() : '';
      if (!match || !redirect) continue;
      rules.push({ match, redirect });
    }
    const result = previewFileWriteRedirect(samplePath, rules);
    if (result) {
      res.json({ matched: true, rule: result.rule, destination: result.destination });
    } else {
      res.json({ matched: false });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Get/set current settings
app.get('/api/settings', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    checkAutonomyExpiry();
    res.json(getCurrentSettings());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/synthesis-stats', async (_req, res) => {
  try {
    const stats = await loadSynthesisStats(PROJECT_DIR);
    const withAdaptive: Record<string, unknown> = {};
    for (const [model, record] of Object.entries(stats)) {
      const backend = model.includes('/') ? model.slice(0, model.indexOf('/')) : 'ollama';
      const isLocal = backend === 'ollama' && !model.includes('cloud');
      const defaultBudget = isLocal ? 180_000 : 600_000;
      withAdaptive[model] = {
        ...record,
        adaptiveMaxTurns: adaptiveMaxTurns(stats, model, 25),
        adaptiveTimeBudgetMs: adaptiveTimeBudget(stats, model, defaultBudget),
      };
    }
    res.json({ stats: withAdaptive, defaultMaxTurns: 25 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/synthesis-stats', async (req, res) => {
  try {
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;
    await clearSynthesisStats(PROJECT_DIR, model);
    res.json({ cleared: model ?? 'all' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
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
  if (req.body.agentPersonality !== undefined) agentPersonality = String(req.body.agentPersonality).slice(0, 5_000);
  if (req.body.agentName !== undefined) agentName = String(req.body.agentName).slice(0, 100);
  if (req.body.agentAvatar !== undefined) agentAvatar = String(req.body.agentAvatar).slice(0, 10);
  if (req.body.agentProfiles !== undefined && typeof req.body.agentProfiles === 'object') agentProfiles = sanitizeAgentProfiles(req.body.agentProfiles);
  if (req.body.allowedExternalPaths !== undefined) {
    const paths = Array.isArray(req.body.allowedExternalPaths) ? req.body.allowedExternalPaths.map((p: unknown) => String(p).slice(0, 500)) : [];
    setAllowedExternalPaths(paths);
  }
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
  if (req.body.automationScheduler !== undefined) {
    automationSchedulerSettings = sanitizeAutomationSchedulerSettings(req.body.automationScheduler);
  }
  configureAutomationScheduler();
  if (req.body.contextMaxTokens !== undefined) contextMaxTokens = clampNumber(req.body.contextMaxTokens, 1024, 200_000, DEFAULT_CONTEXT_MAX_TOKENS);
  if (req.body.timeBudgetMs !== undefined) timeBudgetMs = clampNumber(req.body.timeBudgetMs, 0, 1_800_000, 0);
  if (req.body.temperature !== undefined) temperature = clampNumber(req.body.temperature, 0, 2, 0.7);
  if (req.body.topP !== undefined) topP = clampNumber(req.body.topP, 0, 1, 0.9);
  if (req.body.agentOutputDir !== undefined) {
    // Trim whitespace; empty string means "use the default agent-outputs/".
    agentOutputDir = String(req.body.agentOutputDir).trim().slice(0, 500);
    if (agentOutputDir) process.env.HARNESS_AGENT_OUTPUT_DIR = agentOutputDir;
    else delete process.env.HARNESS_AGENT_OUTPUT_DIR;
    // Make this folder writable by file_write/file_read/list_files even
    // when it lives outside the project. Without this, an agent calling
    // file_write directly to "C:/Users/Brad/Documents/Oracle/foo.js"
    // gets "Path is outside the project directory" rejected. Merge with
    // any existing user-managed allowed paths so we never silently drop
    // their config.
    syncAgentOutputDirIntoAllowedPaths();
  }
  await saveSettingsToDisk();
  logger.info('Settings', 'Updated', { model: currentModel, permissionMode, temperature, topP });
  res.json(getCurrentSettings());
});

app.get('/api/output-validation/profiles', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    res.json({ profiles: getOutputValidationProfiles(), customProfiles: customOutputValidationProfiles, path: '.harness/output-validation-profiles.json' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/output-validation/templates', async (_req, res) => {
  res.json({ templates: OUTPUT_VALIDATION_PROFILE_TEMPLATES });
});

app.post('/api/output-validation/suggest-profile', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const input = String(req.body?.input ?? req.body?.message ?? '').slice(0, 20_000);
    const suggestion = describeOutputValidationProfileSuggestion(input, 'oracle-prime');
    const metadata = OUTPUT_VALIDATION_PROFILES.find((candidate) => candidate.profile === suggestion.profile);
    res.json({ profile: suggestion.profile, label: metadata?.label ?? suggestion.profile, reason: suggestionReason(suggestion.profile, suggestion.matched), matched: suggestion.matched });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/output-validation/feedback', async (req, res) => {
  try {
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/output-validation/feedback-replay', async (_req, res) => {
  try {
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
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

type ReadinessStatus = 'ready' | 'warn' | 'blocked';

interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  message: string;
  action?: string;
}

function readinessStatus(checks: ReadinessCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === 'blocked')) return 'blocked';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ready';
}

function readinessScore(checks: ReadinessCheck[]): number {
  if (checks.length === 0) return 0;
  const points = checks.reduce((sum, check) => sum + (check.status === 'ready' ? 1 : check.status === 'warn' ? 0.5 : 0), 0);
  return Math.round((points / checks.length) * 100);
}

function readinessSection(id: string, label: string, checks: ReadinessCheck[]): { id: string; label: string; score: number; status: ReadinessStatus; checks: ReadinessCheck[] } {
  return { id, label, score: readinessScore(checks), status: readinessStatus(checks), checks };
}

function detectEvidenceMode(message: string): EvidenceMode {
  const lower = message.toLowerCase();
  if (/\b(debug|failing|failed|error|exception|broken|diagnose|fix test)\b/.test(lower)) return 'debug';
  if (/\b(review|audit|risk|regression|inspect)\b/.test(lower)) return 'review';
  if (/\b(research|search|find|summarize|source|citation|web|docs)\b/.test(lower)) return 'research';
  if (/\b(schedule|automate|automation|nightly|recurring|autonomy|autonomous)\b/.test(lower)) return 'automate';
  if (/\b(skill|memory|remember|teach|workflow|learn)\b/.test(lower)) return 'teach';
  if (/\b(build|create|implement|edit|write|code|test)\b/.test(lower)) return 'build';
  return 'general';
}

function summarizeForEvidence(value: unknown, maxLength = 220): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return raw.replace(/\s+/g, ' ').slice(0, maxLength);
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

function parseNonNegativeInteger(value: unknown, fallback: number, max = 100): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function operatingServiceLifecycleAudit() {
  return {
    capture_points: ['chat_operate_intercept', 'run_evidence', 'automation_runs', 'service_state', 'discovery_detail'],
    persistence: ['.harness/services', '.harness/automations/jobs.json', '.harness/evidence'],
    model_agnostic: true,
  };
}

async function recordOperatingServiceEvidence(action: 'export' | 'import', serviceIds: string[], summary: string): Promise<void> {
  const card: StoredRunEvidence = {
    id: `operating-service-${action}:${new Date().toISOString()}:${crypto.randomUUID()}`,
    runId: `operating-service-${action}`,
    runName: `Operating service ${action}`,
    kind: 'chat',
    mode: 'automate',
    createdAt: new Date().toISOString(),
    request: `Operating services ${action}`,
    model: currentModel,
    backend: currentModel.includes('/') ? currentModel.slice(0, currentModel.indexOf('/')) : 'ollama',
    permissionMode,
    capabilityGrantCount: listActiveCapabilityGrants(capabilityGrants).length,
    toolSuccessRate: 1,
    tools: [{ name: `operating_services_${action}`, success: true, outputSummary: summary }],
    files: [{ path: '.harness/services', action: action === 'export' ? 'read' : 'write' }],
    commands: [],
    artifacts: serviceIds.map((serviceId) => ({ title: serviceId, kind: 'operating-service' })),
    recovery: { stopReason: 'completed' },
  };
  await appendRunEvidence(PROJECT_DIR, card);
}

function evidenceFilesFromTool(callName: string, input: Record<string, unknown>): EvidenceFileSummary[] {
  const fileAction: EvidenceFileSummary['action'] = callName === 'file_read' ? 'read'
    : callName === 'file_write' ? 'write'
    : callName === 'file_edit' ? 'edit'
    : callName === 'file_move' ? 'move'
    : callName === 'file_delete' ? 'delete'
    : 'unknown';
  if (!callName.startsWith('file_')) return [];
  const paths = [input.path, input.source, input.destination]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return paths.map((filePath) => ({ path: filePath, action: fileAction }));
}

function checkToolEnabled(toolName: string): ReadinessCheck {
  return !isToolEnabled(toolName)
    ? { id: `tool.${toolName}`, label: `${toolName} enabled`, status: 'blocked', message: `${toolName} is disabled.`, action: 'Open Tools' }
    : { id: `tool.${toolName}`, label: `${toolName} enabled`, status: 'ready', message: `${toolName} is available.` };
}

async function buildAutonomyPreflight(planPreview?: Awaited<ReturnType<typeof readAutonomyPlanPreview>>): Promise<{ blocked: ReadinessCheck[]; warnings: ReadinessCheck[] }> {
  await ensureSettingsLoaded();
  const setup = await checkSetupHealth({ host: ollamaHost, visionModel: mediaTools.visionModel, audioTranscribeCommand: mediaTools.audioTranscribeCommand, pdfOcrCommand: mediaTools.pdfOcrCommand, projectDir: PROJECT_DIR });
  const activeGrants = listActiveCapabilityGrants(capabilityGrants);
  const grantIds = new Set(activeGrants.map((grant) => grant.capabilityId));
  const modelBackend = currentModel.includes('/') ? currentModel.slice(0, currentModel.indexOf('/')) : 'ollama';
  const remoteBackendConfigured = modelBackend !== 'ollama' && Boolean(OPENAI_COMPATIBLE_PRESETS[modelBackend] && readApiKey(OPENAI_COMPATIBLE_PRESETS[modelBackend]));
  const modelHealthy = currentModel ? (modelBackend === 'ollama' ? setup.ollama.ok : remoteBackendConfigured) : false;
  const checks: ReadinessCheck[] = [
    { id: 'model.selected', label: 'Model selected', status: currentModel ? 'ready' : 'blocked', message: currentModel ? `Selected ${currentModel}.` : 'No model selected.' },
    { id: 'model.health', label: 'Model backend health', status: modelHealthy ? 'ready' : 'blocked', message: modelHealthy ? `${modelBackend} backend is available.` : `${modelBackend} backend is not ready.` },
    { id: 'plan.pending', label: 'Pending plan tasks', status: planPreview && planPreview.pending > 0 ? 'ready' : 'blocked', message: planPreview ? `${planPreview.pending} pending task(s) in IMPLEMENTATION_PLAN.md.` : 'IMPLEMENTATION_PLAN.md could not be parsed.' },
    { id: 'kill.switch', label: 'Kill switch clear', status: killSwitchActive ? 'blocked' : 'ready', message: killSwitchActive ? `Kill switch active: ${killSwitchReason}` : 'Kill switch is clear.' },
    { id: 'validation.scripts', label: 'Validation scripts', status: setup.local.package.ok ? 'ready' : 'blocked', message: setup.local.package.message },
    checkToolEnabled('bash'),
    checkToolEnabled('file_edit'),
    checkToolEnabled('file_write'),
    { id: 'permission.mode', label: 'Permission mode', status: permissionMode === 'dontAsk' ? 'ready' : 'blocked', message: permissionMode === 'dontAsk' && autonomyExpiresAt > Date.now() ? `dontAsk (timed, ${formatMinutesRemaining(autonomyExpiresAt)} remaining)` : `Current mode is ${permissionMode}.` },
    { id: 'shell.grant', label: 'Shell grant', status: grantIds.has('arbitrary-shell') || permissionMode === 'dontAsk' ? 'ready' : 'blocked', message: grantIds.has('arbitrary-shell') || permissionMode === 'dontAsk' ? 'Shell capability is grant-ready.' : 'Shell execution needs an active grant.' },
    { id: 'background.autonomy.grant', label: 'Background autonomy grant', status: grantIds.has('background-autonomous-jobs') || permissionMode === 'dontAsk' ? 'ready' : 'blocked', message: grantIds.has('background-autonomous-jobs') || permissionMode === 'dontAsk' ? 'Background autonomy capability is grant-ready.' : 'Background jobs need an active grant.' },
  ];
  return { blocked: checks.filter((check) => check.status === 'blocked'), warnings: checks.filter((check) => check.status === 'warn') };
}

app.get('/api/readiness', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    const setup = await checkSetupHealth({ host: ollamaHost, visionModel: mediaTools.visionModel, audioTranscribeCommand: mediaTools.audioTranscribeCommand, pdfOcrCommand: mediaTools.pdfOcrCommand, projectDir: PROJECT_DIR });
    const activeGrants = listActiveCapabilityGrants(capabilityGrants);
    const capabilities = listCapabilityPolicies();
    const ragIndexes = await ragIndex.listIndexes(PROJECT_DIR).catch(() => []);
    const planPreview = await readAutonomyPlanPreview().catch(() => null);
    const automationJobs = await listAutomationJobs(PROJECT_DIR).catch(() => []);
    const agenticServices = await listAgenticServices(PROJECT_DIR).catch(() => []);
    const promiseObligations = await checkObligations(PROJECT_DIR).catch(() => ({ total: 0, pending: 0, fulfilled: 0, failed: 0, expired: 0, breaches: [] }));
    const repoGraphSummary = await loadRepoGraph(PROJECT_DIR).then((g) => g ? summarizeRepo(g) : null).catch(() => null);
    const validationScripts = setup.local.package.ok;
    const modelSelected = Boolean(currentModel);
    const modelBackend = currentModel.includes('/') ? currentModel.slice(0, currentModel.indexOf('/')) : 'ollama';
    const remoteBackendConfigured = modelBackend !== 'ollama' && Boolean(OPENAI_COMPATIBLE_PRESETS[modelBackend] && readApiKey(OPENAI_COMPATIBLE_PRESETS[modelBackend]));
    const modelHealthy = currentModel
      ? (modelBackend === 'ollama' ? setup.ollama.ok : remoteBackendConfigured)
      : false;
    const grantIds = new Set(activeGrants.map((grant) => grant.capabilityId));
    const hasShellGrant = grantIds.has('arbitrary-shell');
    const hasBackgroundGrant = grantIds.has('background-autonomous-jobs');
    const hasSelfModifyGrant = grantIds.has('self-modifying-code');
    const sections = [
      readinessSection('chat', 'Chat', [
        { id: 'model.selected', label: 'Model selected', status: modelSelected ? 'ready' : 'blocked', message: modelSelected ? `Selected ${currentModel}.` : 'No model selected.', action: 'Pick a model' },
        { id: 'model.health', label: 'Model backend health', status: modelHealthy ? 'ready' : 'blocked', message: modelHealthy ? `${modelBackend} backend is available.` : `${modelBackend} backend is not ready.`, action: 'Open Settings' },
        { id: 'context.window', label: 'Context window', status: contextMaxTokens >= 4096 ? 'ready' : 'warn', message: `Configured context max is ${contextMaxTokens} tokens.` },
      ]),
      readinessSection('coding', 'Coding', [
        checkToolEnabled('file_read'),
        checkToolEnabled('file_write'),
        checkToolEnabled('file_edit'),
        { id: 'validation.scripts', label: 'Validation scripts', status: validationScripts ? 'ready' : 'warn', message: setup.local.package.message, action: 'Run doctor' },
        { id: 'self.modify.grant', label: 'Self-modifying grant', status: hasSelfModifyGrant || permissionMode === 'dontAsk' ? 'ready' : 'warn', message: hasSelfModifyGrant || permissionMode === 'dontAsk' ? 'Self-modifying code is grant-ready.' : 'Self-modifying code may prompt before file edits.', action: 'Open Tools' },
      ]),
      readinessSection('research', 'Research', [
        checkToolEnabled('web_search'),
        checkToolEnabled('web_read'),
        { id: 'rag.indexes', label: 'RAG indexes', status: ragIndexes.length > 0 ? 'ready' : 'warn', message: ragIndexes.length > 0 ? `${ragIndexes.length} RAG index(es) available.` : 'No local RAG indexes yet.', action: 'Open RAG' },
      ]),
      readinessSection('automation', 'Automation', [
        { id: 'scheduler.enabled', label: 'Scheduler enabled', status: automationSchedulerSettings.enabled ? 'ready' : 'warn', message: automationSchedulerSettings.enabled ? 'Automation scheduler is enabled.' : 'Automation scheduler is disabled.', action: 'Open Settings' },
        { id: 'automation.jobs', label: 'Automation jobs', status: automationJobs.length > 0 ? 'ready' : 'warn', message: `${automationJobs.length} automation job(s) configured.`, action: 'Open Runs' },
        { id: 'background.grant', label: 'Background grant', status: hasBackgroundGrant || permissionMode === 'dontAsk' ? 'ready' : 'warn', message: hasBackgroundGrant || permissionMode === 'dontAsk' ? 'Background jobs can run with active grant posture.' : 'Background jobs need a grant for autonomous execution.', action: 'Open Tools' },
        { id: 'kill.switch', label: 'Kill switch clear', status: killSwitchActive ? 'blocked' : 'ready', message: killSwitchActive ? `Kill switch active: ${killSwitchReason}` : 'Kill switch is clear.' },
      ]),
      readinessSection('services', 'Operating Services', [
        { id: 'services.configured', label: 'Services configured', status: agenticServices.length > 0 ? 'ready' : 'warn', message: `${agenticServices.length} operating service(s) configured.` },
        { id: 'services.scheduler', label: 'Service scheduler', status: automationSchedulerSettings.enabled ? 'ready' : 'warn', message: automationSchedulerSettings.enabled ? 'Scheduled operating services can run.' : 'Operating service state can be created, but proactive reminders require a scheduler/automation capability.', action: 'Open Settings' },
        { id: 'services.storage', label: 'Service storage', status: 'ready', message: 'Operating service state is stored under .harness/services/.' },
      ]),
      readinessSection('promises', 'Promise Ledger', [
        { id: 'promises.total', label: 'Promises tracked', status: promiseObligations.total > 0 ? 'ready' : 'warn', message: `${promiseObligations.total} promise(s) total · ${promiseObligations.pending} pending · ${promiseObligations.fulfilled} fulfilled.` },
        { id: 'promises.breaches', label: 'Obligation breaches', status: promiseObligations.breaches.length === 0 ? 'ready' : 'warn', message: promiseObligations.breaches.length === 0 ? 'No obligation breaches.' : `${promiseObligations.breaches.length} breach(es): ${promiseObligations.breaches.map((b: { breach_type: string }) => b.breach_type).join(', ')}.`, action: 'Open Promises' },
      ]),
      readinessSection('codeintel', 'Code Intelligence', [
        { id: 'codeintel.graph', label: 'Repo graph', status: repoGraphSummary ? 'ready' : 'warn', message: repoGraphSummary ? `${repoGraphSummary.total_files} files, ${repoGraphSummary.total_edges} edges, ${repoGraphSummary.test_files} tests indexed.` : 'No repo graph built yet. Build from Code Intel tab or restart server.' },
        { id: 'codeintel.coverage', label: 'Export coverage', status: repoGraphSummary && repoGraphSummary.total_exports > 100 ? 'ready' : 'warn', message: repoGraphSummary ? `${repoGraphSummary.total_exports} exports tracked across ${repoGraphSummary.total_files} files.` : 'Not available.' },
      ]),
      readinessSection('autonomy', 'Full Autonomy', [
        { id: 'plan.pending', label: 'Pending plan tasks', status: planPreview && planPreview.pending > 0 ? 'ready' : planPreview ? 'warn' : 'blocked', message: planPreview ? (planPreview.pending > 0 ? `${planPreview.pending} pending task(s) in IMPLEMENTATION_PLAN.md.` : `Plan complete — all ${planPreview.done} task(s) done.`) : 'IMPLEMENTATION_PLAN.md could not be parsed.', action: 'Open Plan' },
        { id: 'permission.mode', label: 'Permission mode', status: permissionMode === 'dontAsk' ? 'ready' : 'warn', message: permissionMode === 'dontAsk' && autonomyExpiresAt > Date.now() ? `dontAsk (timed, ${formatMinutesRemaining(autonomyExpiresAt)} remaining)` : `Current mode is ${permissionMode}.`, action: 'Open Settings' },
        { id: 'shell.grant', label: 'Shell grant', status: hasShellGrant || permissionMode === 'dontAsk' ? 'ready' : 'warn', message: hasShellGrant || permissionMode === 'dontAsk' ? 'Shell capability is grant-ready.' : 'Shell execution may prompt or be denied.', action: 'Open Tools' },
        { id: 'background.autonomy.grant', label: 'Background autonomy grant', status: hasBackgroundGrant || permissionMode === 'dontAsk' ? 'ready' : 'warn', message: hasBackgroundGrant || permissionMode === 'dontAsk' ? 'Background autonomy capability is grant-ready.' : 'Background jobs need an active grant.', action: 'Open Tools' },
        { id: 'blocked.capabilities', label: 'Blocked capability policy', status: summarizeCapabilityAlignment(capabilities).blocked >= 3 ? 'ready' : 'warn', message: `${summarizeCapabilityAlignment(capabilities).blocked} blocked high-risk capability surface(s).` },
        { id: 'autonomy.kill.switch', label: 'Kill switch clear', status: killSwitchActive ? 'blocked' : 'ready', message: killSwitchActive ? `Kill switch active: ${killSwitchReason}` : 'Kill switch is clear.' },
      ]),
    ];
    res.json({ generatedAt: new Date().toISOString(), model: currentModel, permissionMode, killSwitch: { active: killSwitchActive, reason: killSwitchReason }, grants: activeGrants.length, sections, nervousSystem: { available: true, modules: ['signals', 'sensory', 'reflexes', 'attention', 'motor', 'pain', 'recovery'] } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/telegram/status', (_req, res) => {
  res.json({
    configured: Boolean(telegramBotToken),
    running: isTelegramBotRunning(),
    hasAllowedChatIds: Boolean(telegramAllowedChatIds),
    pollingLock: getTelegramPollingLockInfo(PROJECT_DIR),
  });
});

app.post('/api/telegram/token', async (req, res) => {
  try {
    const token = String(req.body?.token ?? '').trim().slice(0, 200);
    const chatIds = String(req.body?.allowedChatIds ?? '').trim().slice(0, 500);
    telegramBotToken = token;
    telegramAllowedChatIds = chatIds;
    await saveSettingsToDisk();
    if (token) {
      const preferred = parseInt(process.env.PORT ?? '3000', 10);
      const url = `http://${LOCAL_HOST}:${preferred}`;
      const bot = startTelegramBot(token, url, chatIds ? chatIds.split(',') : undefined);
      res.json({ ok: true, running: Boolean(bot) });
    } else {
      stopTelegramBot();
      res.json({ ok: true, running: false });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/telegram/stop', (_req, res) => {
  stopTelegramBot();
  res.json({ ok: true, running: false });
});

// ─── Discord bot routes ─────────────────────────────────────────────

app.get('/api/discord/status', (_req, res) => {
  res.json({
    running: isDiscordBotRunning(),
    configured: Boolean(discordBotToken || process.env.HARNESS_DISCORD_BOT_TOKEN),
  });
});

app.post('/api/discord/token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const channelIds = typeof req.body?.channelIds === 'string' ? req.body.channelIds.trim() : '';
  if (!token) { res.status(400).json({ error: 'Discord bot token is required.' }); return; }
  stopDiscordBot();
  discordBotToken = token;
  discordAllowedChannelIds = channelIds;
  await ensureSettingsLoaded();
  await saveSettingsToDisk();
  const url = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const bot = startDiscordBot(token, url, channelIds ? channelIds.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined);
  res.json({ ok: Boolean(bot), running: isDiscordBotRunning() });
});

app.post('/api/discord/stop', (_req, res) => {
  stopDiscordBot();
  res.json({ ok: true, running: false });
});

app.get('/api/webhooks', (_req, res) => {
  res.json({ webhooks: listWebhooks() });
});

app.get('/api/nervous', (_req, res) => {
  const state = globalNervousSystem.getRunState();
  const signals = globalNervousSystem.getSignals();
  const summary = globalNervousSystem.getSummary();
  const recovery = globalNervousSystem.getRecoveryPlan();
  res.json({
    active: state !== null,
    permissionMode,
    verificationBypassActive: shouldBypassNervousVerification(),
    summary,
    signals: signals.slice(-20).map((s) => ({ type: s.type, severity: s.severity, message: s.message, source: s.source, createdAt: s.createdAt })),
    recovery: recovery ? { reason: recovery.reason, safeNextAction: recovery.safeNextAction } : null,
  });
});

app.get('/api/nervous/history', async (_req, res) => {
  try {
    const history = await NervousSystemController.readPersistedSignals(PROJECT_DIR, 100);
    res.json({ signals: history });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/webhooks', (req, res) => {
  try {
    const url = String(req.body?.url ?? '').trim();
    if (!url) { res.status(400).json({ error: 'url is required' }); return; }
    const secret = typeof req.body?.secret === 'string' ? req.body.secret.trim() : undefined;
    const events = Array.isArray(req.body?.events) ? req.body.events.map(String) : [];
    const webhook = addWebhook({ url, secret, events, enabled: true });
    res.json({ ok: true, webhook: { ...webhook, secret: secret ? '***' : undefined } });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/webhooks/:id', (req, res) => {
  const removed = removeWebhook(String(req.params.id));
  if (!removed) { res.status(404).json({ error: 'Webhook not found' }); return; }
  res.json({ ok: true });
});

app.get('/api/discovery', async (_req, res) => {
  await ensureSettingsLoaded();
  // Refresh capability registry with current server state
  refreshCapabilityRegistry();
  try {
    const automationPolicy = getAutomationPolicyContext();
    const ttlMs = modelCatalog.ttlHours * 60 * 60 * 1000;
    const [catalog, catalogStatus, extensions, automationJobs, dueAutomations, agenticServices, sessionSearch, runtimeSkills, repoSkills, curatorLog] = await Promise.all([
      getModelCatalog(PROJECT_DIR, { url: modelCatalog.url || undefined, ttlMs, fetchJson: fetchJsonFromUrl }),
      getModelCatalogCacheStatus(PROJECT_DIR, new Date(), ttlMs),
      discoverExtensionManifests(PROJECT_DIR),
      listAutomationJobs(PROJECT_DIR),
      listDueAutomationJobs(PROJECT_DIR),
      listAgenticServices(PROJECT_DIR),
      getSessionSearchIndexStatus(PROJECT_DIR),
      scanSkillsDir(SKILLS_DIR),
      scanSkillsDir(REPO_SKILLS_DIR),
      readCuratorLog(PROJECT_DIR, 10),
    ]);
    res.json({
      modelCatalog: { settings: modelCatalog, status: catalogStatus, manifest: catalog },
      extensions: {
        policy: extensionActivation,
        manifests: extensions.map((manifest) => ({ ...manifest, activation: describeExtensionActivation(manifest.kind, manifest.name, manifest.enabled) })),
        skills: {
          runtime: { directory: SKILLS_DIR, total: runtimeSkills.skills.length, diagnosticCount: runtimeSkills.diagnostics.length, diagnostics: runtimeSkills.diagnostics },
          repo: { directory: REPO_SKILLS_DIR, total: repoSkills.skills.length, diagnosticCount: repoSkills.diagnostics.length, diagnostics: repoSkills.diagnostics },
          sources: [
            skillSourceForApi('runtime', 'Runtime skills', SKILLS_DIR, runtimeSkills, true),
            skillSourceForApi('repo', 'Repo skills', REPO_SKILLS_DIR, repoSkills, false),
          ],
        },
      },
      automations: { total: automationJobs.length, due: dueAutomations, jobs: automationJobs, policy: { activeGrantCount: automationPolicy.grants.length, killSwitchActive: automationPolicy.killSwitchActive }, schedulerRunning: Boolean(automationScheduler) },
      services: { total: agenticServices.length, limit: 8, offset: 0, lifecycle: operatingServiceLifecycleAudit(), services: agenticServices.slice(0, 8).map((item) => ({ service_id: item.service.service_id, service_name: item.service.service_name, mode: item.service.mode, purpose: item.service.purpose, updated_at: item.service.updated_at, automation_job_id: item.service.automation_job_id })) },
      sessionSearch,
      curator: {
        enabled: curatorSettings.enabled,
        schedulerRunning: Boolean(curatorScheduler),
        intervalHours: curatorSettings.intervalHours,
        idleThresholdMinutes: curatorSettings.idleThresholdMinutes,
        lastRunAt: curatorSettings.lastRunAt,
        recentEvents: curatorLog,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// ─── Capability Registry ────────────────────────────────────────────

function refreshCapabilityRegistry(): void {
  // Dynamically update capability status based on current server state
  capabilityRegistry.register('ollama', 'Ollama LLM backend',
    ollamaHost ? 'available' : 'unavailable',
    ollamaHost ? `Connected to ${ollamaHost}` : 'No Ollama host configured.');
  capabilityRegistry.register('telegram', 'Telegram messaging',
    telegramBotToken ? 'available' : 'unavailable',
    telegramBotToken ? 'Telegram bot token configured.' : 'No Telegram bot token configured.');
  capabilityRegistry.register('cloud_models', 'Cloud LLM backends',
    Object.values(OPENAI_COMPATIBLE_PRESETS).some((preset) => readApiKey(preset)) ? 'available' : 'unavailable',
    'Checked API key env vars for cloud backends.');
  capabilityRegistry.register('email', 'Email sending',
    process.env.HARNESS_SMTP_HOST ? 'available' : 'unavailable',
    process.env.HARNESS_SMTP_HOST ? 'SMTP configured.' : 'No SMTP configured.');
}

app.get('/api/capabilities/registry', async (_req, res) => {
  await ensureSettingsLoaded();
  refreshCapabilityRegistry();
  res.json({
    capabilities: capabilityRegistry.list(),
    available: capabilityRegistry.available().map((c) => c.id),
    missing: capabilityRegistry.missing().map((c) => ({ id: c.id, reason: c.reason })),
  });
});

// ─── Worker Queue status ────────────────────────────────────────────
const workerQueue = new WorkerQueue();

app.get('/api/worker/status', (_req, res) => {
  res.json({ pending: workerQueue.pendingCount(), queue: workerQueue.pending(), history: workerQueue.history() });
});

// ─── Mode classification ────────────────────────────────────────────
app.get('/api/modes/classify', (req, res) => {
  const message = typeof req.query.message === 'string' ? req.query.message : '';
  if (!message) { res.status(400).json({ error: 'message query parameter is required' }); return; }
  res.json(classifyMode(message));
});

app.get('/api/services', async (req, res) => {
  try {
    const limit = parseNonNegativeInteger(req.query.limit, 50, 200);
    const offset = parseNonNegativeInteger(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
    const services = await listAgenticServices(PROJECT_DIR);
    const page = services.slice(offset, offset + limit);
    res.json({ total: services.length, limit, offset, lifecycle: operatingServiceLifecycleAudit(), services: page.map((item) => ({ service: item.service, stateSummary: summarizeServiceState(item.state) })) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/services/export', async (req, res) => {
  try {
    const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
    const payload = await exportAgenticServices(PROJECT_DIR, ids);
    await recordOperatingServiceEvidence('export', payload.services.map((item) => item.service.service_id), `Exported ${payload.services.length} operating service(s).`).catch((error) => logger.warn('Services', 'Failed to record service export evidence', { error: error instanceof Error ? error.message : String(error) }));
    res.setHeader('Content-Disposition', `attachment; filename="operating-services-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(payload);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/services/import', async (req, res) => {
  try {
    const overwrite = req.query.overwrite === 'true' || req.body?.overwrite === true;
    const payload = req.body?.payload ?? req.body;
    const result = await importAgenticServices(PROJECT_DIR, payload, { overwrite });
    await recordOperatingServiceEvidence('import', [...result.imported, ...result.skipped], `Imported ${result.imported.length} and skipped ${result.skipped.length} operating service(s).`).catch((error) => logger.warn('Services', 'Failed to record service import evidence', { error: error instanceof Error ? error.message : String(error) }));
    res.json({ ok: true, ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: msg });
  }
});

app.get('/api/services/:id', async (req, res) => {
  try {
    const serviceId = safeLocalId(req.params.id);
    if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
    const service = await getAgenticService(PROJECT_DIR, serviceId);
    if (!service) { res.status(404).json({ error: 'Service not found.' }); return; }
    res.json(service);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// ─── Service Templates (must come before :id route) ─────────────────
app.get('/api/services/templates', async (_req, res) => {
  res.json(SERVICE_TEMPLATES);
});

// ─── Service Lifecycle ──────────────────────────────────────────────

app.get('/api/services/:id/lifecycle', async (req, res) => {
  try {
    const serviceId = safeLocalId(req.params.id);
    if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
    const lifecycle = await getServiceLifecycle(PROJECT_DIR, serviceId);
    if (!lifecycle) { res.status(404).json({ error: 'No lifecycle found. Use POST to initialize.' }); return; }
    res.json(lifecycle);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/services/:id/lifecycle', async (req, res) => {
  try {
    const serviceId = safeLocalId(req.params.id);
    if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
    const targetStatus = req.body?.status as ServiceLifecycleStatus | undefined;
    if (!targetStatus) { res.status(400).json({ error: 'status is required.' }); return; }
    const existing = await getServiceLifecycle(PROJECT_DIR, serviceId);
    if (!existing) {
      const state = await initServiceLifecycle(PROJECT_DIR, serviceId, targetStatus);
      await emitEvent(PROJECT_DIR, 'service', 'lifecycle_initialized', { service_id: serviceId, status: targetStatus }, 'user', serviceId).catch(() => {});
      res.json({ success: true, state });
      return;
    }
    const result = await transitionService(PROJECT_DIR, serviceId, targetStatus, req.body?.error_message);
    if (result.success) {
      await emitEvent(PROJECT_DIR, 'service', 'lifecycle_transitioned', { service_id: serviceId, from: result.from, to: result.to }, 'user', serviceId).catch(() => {});
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/services/:id/health', async (req, res) => {
  try {
    const serviceId = safeLocalId(req.params.id);
    if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
    const health = await probeServiceHealth(PROJECT_DIR, serviceId);
    res.json(health);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Promise Ledger ─────────────────────────────────────────────────

app.get('/api/promises', async (req, res) => {
  try {
    const status = req.query.status as PromiseStatus | undefined;
    const service_id = typeof req.query.service_id === 'string' ? req.query.service_id : undefined;
    const promises = await listPromises(PROJECT_DIR, { status, service_id });
    res.json({ total: promises.length, promises });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/promises', async (req, res) => {
  try {
    const { commitment, service_id, schedule_id, capability_required, next_due_at, fallback_message, session_id } = req.body ?? {};
    if (!commitment || typeof commitment !== 'string') { res.status(400).json({ error: 'commitment is required.' }); return; }
    const promise = await createPromise(PROJECT_DIR, commitment, { service_id, schedule_id, capability_required, next_due_at, fallback_message, session_id });
    await emitEvent(PROJECT_DIR, 'promise', 'promise_created', { promise_id: promise.promise_id, commitment }, 'user', promise.promise_id).catch(() => {});
    res.json(promise);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/promises/:id/fulfil', async (req, res) => {
  try {
    const promiseId = req.params.id;
    const result = await fulfilPromise(PROJECT_DIR, promiseId);
    if (!result) { res.status(404).json({ error: 'Promise not found.' }); return; }
    await emitEvent(PROJECT_DIR, 'promise', 'promise_fulfilled', { promise_id: promiseId }, 'system', promiseId).catch(() => {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/promises/:id/fail', async (req, res) => {
  try {
    const promiseId = req.params.id;
    const markFailed = req.body?.markFailed === true;
    const result = await failPromise(PROJECT_DIR, promiseId, markFailed);
    if (!result) { res.status(404).json({ error: 'Promise not found.' }); return; }
    await emitEvent(PROJECT_DIR, 'promise', 'promise_failed', { promise_id: promiseId, markFailed }, 'system', promiseId).catch(() => {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/promises/obligations', async (_req, res) => {
  try {
    const result = await checkObligations(PROJECT_DIR);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/promises/:id/cancel', async (req, res) => {
  try {
    const promiseId = req.params.id;
    const result = await updatePromise(PROJECT_DIR, promiseId, { status: 'cancelled' });
    if (!result) { res.status(404).json({ error: 'Promise not found.' }); return; }
    await emitEvent(PROJECT_DIR, 'promise', 'promise_cancelled', { promise_id: promiseId }, 'user', promiseId).catch(() => {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Event Store ────────────────────────────────────────────────────

app.get('/api/events', async (req, res) => {
  try {
    const query = {
      category: req.query.category as EventCategory | undefined,
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      subject_id: typeof req.query.subject_id === 'string' ? req.query.subject_id : undefined,
      after: typeof req.query.after === 'string' ? req.query.after : undefined,
      before: typeof req.query.before === 'string' ? req.query.before : undefined,
      limit: typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 50 : 50,
      actor: typeof req.query.actor === 'string' ? req.query.actor : undefined,
    };
    const events = await queryEvents(PROJECT_DIR, query);
    res.json({ total: events.length, events });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/events/summary', async (_req, res) => {
  try {
    const summary = await summarizeEventStore(PROJECT_DIR);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/events/postmortem/:id', async (req, res) => {
  try {
    const subjectId = req.params.id;
    const window = typeof req.query.window === 'string' ? parseInt(req.query.window, 10) || 30 : 30;
    const postmortem = await generatePostmortem(PROJECT_DIR, subjectId, window);
    res.json({ postmortem });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/events/snapshots', async (_req, res) => {
  try {
    const subjects = await listSnapshots(PROJECT_DIR);
    res.json({ subjects });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/events/snapshots/:id', async (req, res) => {
  try {
    const snapshot = await getSnapshot(PROJECT_DIR, req.params.id);
    if (!snapshot) { res.status(404).json({ error: 'Snapshot not found.' }); return; }
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const unsubscribe = subscribeEventStream((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

app.post('/api/events', async (req, res) => {
  try {
    const { category, type, data, actor, subject_id, parent_event_id } = req.body ?? {};
    if (!category || !type) { res.status(400).json({ error: 'category and type are required.' }); return; }
    const validCategories: EventCategory[] = ['service', 'promise', 'task', 'tool', 'model', 'route', 'approval', 'file', 'schedule', 'notification', 'permission', 'system'];
    if (!validCategories.includes(category)) { res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` }); return; }
    const event = await emitEvent(PROJECT_DIR, category, type, data ?? {}, actor ?? 'external', subject_id, parent_event_id);
    res.json(event);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Done-State Verifier ────────────────────────────────────────────

app.post('/api/verify/code', async (req, res) => {
  try {
    const quick = req.body?.quick === true;
    const result = await verifyCode({ projectDir: PROJECT_DIR, quick });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/verify/service/:id', async (req, res) => {
  try {
    const serviceId = safeLocalId(req.params.id);
    if (!serviceId) { res.status(400).json({ error: 'Invalid service id.' }); return; }
    const result = await verifyService(PROJECT_DIR, serviceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Code Intelligence ──────────────────────────────────────────────

app.post('/api/code-intelligence/build', async (_req, res) => {
  try {
    const graph = await buildRepoGraph(PROJECT_DIR);
    await saveRepoGraph(PROJECT_DIR, graph);
    const summary = summarizeRepo(graph);
    await emitEvent(PROJECT_DIR, 'system', 'repo_graph_built', { files: summary.total_files, edges: summary.total_edges }, 'system').catch(() => {});
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/code-intelligence/summary', async (_req, res) => {
  try {
    const graph = await loadRepoGraph(PROJECT_DIR);
    if (!graph) { res.status(404).json({ error: 'No repo graph built yet. POST /api/code-intelligence/build first.' }); return; }
    res.json(summarizeRepo(graph));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/code-intelligence/impact', async (req, res) => {
  try {
    const files = req.body?.files as string[] | undefined;
    if (!Array.isArray(files) || files.length === 0) { res.status(400).json({ error: 'files array is required.' }); return; }
    const graph = await loadRepoGraph(PROJECT_DIR);
    if (!graph) { res.status(404).json({ error: 'No repo graph. POST /api/code-intelligence/build first.' }); return; }
    const impact = analyzeImpact(graph, files);
    res.json(impact);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/code-intelligence/diagram', async (_req, res) => {
  try {
    const graph = await loadRepoGraph(PROJECT_DIR);
    if (!graph) { res.status(404).json({ error: 'No repo graph. Build first.' }); return; }
    const { generateArchitectureDiagram } = await import('../core/codeIntelligence');
    const mermaid = generateArchitectureDiagram(graph);
    res.json({ mermaid });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/subsystems/health', async (_req, res) => {
  try {
    const [obligations, eventSummary, repoGraph, services, shortcutEvents] = await Promise.allSettled([
      checkObligations(PROJECT_DIR),
      summarizeEventStore(PROJECT_DIR),
      loadRepoGraph(PROJECT_DIR).then((g) => g ? summarizeRepo(g) : null),
      listAgenticServices(PROJECT_DIR),
      queryEvents(PROJECT_DIR, { type: 'deterministic_shortcut', limit: 1000 }),
    ]);

    const promiseHealth = obligations.status === 'fulfilled' ? obligations.value : null;
    const events = eventSummary.status === 'fulfilled' ? eventSummary.value : null;
    const codeIntel = repoGraph.status === 'fulfilled' ? repoGraph.value : null;
    const svcList = services.status === 'fulfilled' ? services.value : [];
    const shortcuts = shortcutEvents.status === 'fulfilled' ? shortcutEvents.value : [];
    const shortcutsByType: Record<string, number> = {};
    for (const ev of shortcuts) {
      const t = (ev.data as { type?: string })?.type ?? 'unknown';
      shortcutsByType[t] = (shortcutsByType[t] ?? 0) + 1;
    }

    const subsystems = {
      promises: {
        status: promiseHealth && promiseHealth.breaches.length === 0 ? 'healthy' : promiseHealth ? 'warning' : 'unknown',
        total: promiseHealth?.total ?? 0,
        pending: promiseHealth?.pending ?? 0,
        fulfilled: promiseHealth?.fulfilled ?? 0,
        breaches: promiseHealth?.breaches.length ?? 0,
      },
      events: {
        status: events && events.total_events > 0 ? 'healthy' : 'empty',
        total_events: events?.total_events ?? 0,
        categories: events?.categories ?? {},
        snapshots: events?.snapshot_count ?? 0,
      },
      code_intelligence: {
        status: codeIntel ? 'healthy' : 'not_built',
        files: codeIntel?.total_files ?? 0,
        edges: codeIntel?.total_edges ?? 0,
        exports: codeIntel?.total_exports ?? 0,
        tests: codeIntel?.test_files ?? 0,
      },
      services: {
        status: svcList.length > 0 ? 'healthy' : 'empty',
        count: svcList.length,
      },
      mycelium: {
        status: 'healthy',
        message: 'Graph loaded from disk on each chat turn.',
      },
      nervous_system: {
        status: 'healthy',
        modules: ['signals', 'sensory', 'reflexes', 'attention', 'motor', 'pain', 'recovery'],
      },
      deterministic_shortcuts: {
        status: shortcuts.length > 0 ? 'active' : 'idle',
        total_hits: shortcuts.length,
        by_type: shortcutsByType,
        message: shortcuts.length > 0 ? `${shortcuts.length} model call(s) avoided by Tier 0 shortcuts.` : 'No shortcuts triggered yet.',
      },
    };

    const overall = Object.values(subsystems).every((s) => s.status === 'healthy' || s.status === 'empty') ? 'healthy' : 'degraded';
    res.json({ overall, generatedAt: new Date().toISOString(), subsystems });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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

type DocumentFormat = 'markdown' | 'html' | 'pdf' | 'docx';
type DocumentTemplate = 'brief' | 'report' | 'runbook' | 'spec' | 'adr' | 'release-notes' | 'handoff';

interface GeneratedDocumentMetadata {
  id: string;
  title: string;
  template: DocumentTemplate;
  format: DocumentFormat;
  filename: string;
  createdAt: string;
  sourceLabel: string;
  size: number;
}

function normalizeDocumentFormat(value: unknown): DocumentFormat {
  return value === 'html' || value === 'pdf' || value === 'docx' ? value : 'markdown';
}

function normalizeDocumentTemplate(value: unknown): DocumentTemplate {
  return value === 'report' || value === 'runbook' || value === 'spec' || value === 'adr' || value === 'release-notes' || value === 'handoff' ? value : 'brief';
}

function documentSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
}

function buildGeneratedDocumentMarkdown(input: { title: string; template: DocumentTemplate; sourceLabel: string; content: string; evidence?: EvidenceCard }): string {
  const title = input.title.trim() || 'Harness Document';
  const content = input.content.trim() || 'No source content was provided.';
  const generatedAt = new Date().toISOString();
  const evidence = input.evidence;
  const sections: string[] = [
    `# ${title}`,
    '',
    `Generated: ${generatedAt}`,
    `Source: ${input.sourceLabel || 'Harness'}`,
    `Template: ${input.template}`,
    '',
  ];
  if (input.template === 'brief') {
    sections.push('## Summary', '', content, '', '## Decisions and Next Steps', '', '* Review the generated content for accuracy.', '* Export or revise the document from Harness.');
  } else if (input.template === 'report') {
    sections.push('## Executive Summary', '', content, '', '## Evidence', '', evidence ? evidenceMarkdown(evidence) : '* No evidence card attached.', '', '## Recommendations', '', '* Confirm open risks and assign owners.', '* Re-run validation before publishing externally.');
  } else if (input.template === 'runbook') {
    sections.push('## Purpose', '', content, '', '## Procedure', '', '1. Confirm prerequisites.', '2. Execute the documented steps.', '3. Validate the outcome.', '4. Record follow-up evidence.', '', '## Rollback', '', '* Use the latest Harness session, trace, or evidence card to recover context.');
  } else if (input.template === 'spec') {
    sections.push('## Context', '', content, '', '## Requirements', '', '* Define expected behavior.', '* Define validation and acceptance criteria.', '', '## Evidence', '', evidence ? evidenceMarkdown(evidence) : '* No evidence card attached.');
  } else if (input.template === 'adr') {
    sections.push('## Status', '', 'Proposed', '', '## Context', '', content, '', '## Decision', '', '* Record the decision made from this evidence.', '', '## Consequences', '', '* Positive: capture expected benefits.', '* Negative: capture tradeoffs or risks.', '', '## Evidence', '', evidence ? evidenceMarkdown(evidence) : '* No evidence card attached.');
  } else if (input.template === 'release-notes') {
    sections.push('## Summary', '', content, '', '## Changes', '', '* Added: capture user-visible additions.', '* Changed: capture behavior changes.', '* Fixed: capture defects resolved.', '', '## Validation', '', evidence?.validation ? `* ${evidence.validation.status} (${Math.round(evidence.validation.score * 100)}%)` : '* Add validation results before release.');
  } else {
    sections.push('## Situation', '', content, '', '## Work Completed', '', '* Summarize completed work.', '', '## Validation', '', evidence ? evidenceMarkdown(evidence) : '* No evidence card attached.', '', '## Follow-Up', '', '* List remaining work and owners.');
  }
  return sections.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function evidenceMarkdown(evidence: EvidenceCard): string {
  const lines = [
    `* Request: ${evidence.request || 'n/a'}`,
    `* Mode: ${evidence.mode}`,
    `* Model: ${evidence.model || 'n/a'}`,
    `* Permission mode: ${evidence.permissionMode || 'n/a'}`,
    `* Tool calls: ${evidence.tools.length}`,
    `* Files referenced: ${evidence.files.length}`,
    `* Commands: ${evidence.commands.length}`,
  ];
  if (evidence.validation) lines.push(`* Validation: ${evidence.validation.status} (${Math.round(evidence.validation.score * 100)}%)`);
  if (evidence.mycelium?.route?.length) lines.push(`* Mycelium route: ${evidence.mycelium.route.join(' > ')}`);
  return lines.join('\n');
}

function markdownToDocumentHtml(markdown: string, title: string): string {
  const body = markdown.split(/\r?\n/).map((line) => {
    if (line.startsWith('# ')) return `<h1>${htmlEscape(line.slice(2))}</h1>`;
    if (line.startsWith('## ')) return `<h2>${htmlEscape(line.slice(3))}</h2>`;
    if (line.startsWith('### ')) return `<h3>${htmlEscape(line.slice(4))}</h3>`;
    if (line.startsWith('* ')) return `<li>${htmlEscape(line.slice(2))}</li>`;
    if (/^\d+\.\s+/.test(line)) return `<li>${htmlEscape(line.replace(/^\d+\.\s+/, ''))}</li>`;
    return line.trim() ? `<p>${htmlEscape(line)}</p>` : '';
  }).join('\n').replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (match) => `<ul>\n${match}</ul>`);
  return '<!doctype html>\n<html><head><meta charset="utf-8"><title>' + htmlEscape(title) + '</title><style>body{font-family:Segoe UI,Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1f2937}h1,h2,h3{color:#111827}code{background:#f3f4f6;padding:2px 4px;border-radius:4px}ul{padding-left:24px}</style></head><body>\n' + body + '\n</body></html>\n';
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function localDocumentConverters(): Promise<{ pandoc: boolean }> {
  return { pandoc: await commandSucceeds(process.env.HARNESS_PANDOC_PATH || 'pandoc', ['--version']) };
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function convertMarkdownDocument(markdown: string, outputPath: string, format: Extract<DocumentFormat, 'pdf' | 'docx'>): Promise<void> {
  const converters = await localDocumentConverters();
  if (!converters.pandoc) throw new Error('PDF and DOCX export require pandoc on PATH or HARNESS_PANDOC_PATH.');
  const sourcePath = outputPath.replace(/\.(pdf|docx)$/i, '.md');
  await fs.writeFile(sourcePath, markdown, 'utf-8');
  const command = process.env.HARNESS_PANDOC_PATH || 'pandoc';
  const child = spawn(command, [sourcePath, '-o', outputPath], { cwd: PROJECT_DIR });
  const [code] = await once(child, 'exit') as [number | null];
  if (code !== 0) throw new Error(`pandoc failed to generate ${format.toUpperCase()} output.`);
}

function createEvidenceLearningCandidate(document: GeneratedDocumentMetadata, evidence: EvidenceCard, content: string) {
  const qualityScore = Number(Math.min(1, 0.65 + Math.min(evidence.tools.length, 4) * 0.05 + (evidence.validation ? 0.1 : 0)).toFixed(3));
  return {
    id: `document:${document.id}`,
    sessionId: evidence.recovery?.sessionId || document.id,
    createdAt: document.createdAt,
    prompt: evidence.request || `${document.template} document from ${document.sourceLabel}`,
    outcome: [`Generated ${document.format.toUpperCase()} document: ${document.title}`, content.slice(0, 1200)].join('\n\n').slice(0, 2000),
    toolNames: evidence.tools.map((tool) => tool.name),
    sourceEventIds: evidence.id ? [evidence.id] : [],
    qualityScore,
    accepted: true,
    rejectionReasons: [],
  };
}

function createRunEvidence(input: { id: string; kind: 'automation' | 'autonomy'; request: string; runName?: string; command?: string; outputPath?: string; success?: boolean; summary?: string }): StoredRunEvidence {
  return {
    id: input.id,
    runId: input.id,
    runName: input.runName,
    kind: input.kind,
    mode: input.kind === 'automation' ? 'automate' : 'build',
    createdAt: new Date().toISOString(),
    request: input.request,
    model: currentModel,
    backend: currentModel.includes('/') ? currentModel.slice(0, currentModel.indexOf('/')) : 'ollama',
    permissionMode,
    capabilityGrantCount: listActiveCapabilityGrants(capabilityGrants).length,
    toolSuccessRate: input.success === false ? 0 : 1,
    tools: [],
    files: input.outputPath ? [{ path: path.relative(PROJECT_DIR, input.outputPath).split(path.sep).join('/'), action: 'write' }] : [],
    commands: input.command ? [{ command: input.command, success: input.success, outputSummary: input.summary }] : [],
    artifacts: input.outputPath ? [{ title: path.basename(input.outputPath), kind: 'run-output' }] : [],
    recovery: { stopReason: input.success === false ? 'failed' : 'completed' },
  };
}

app.get('/api/evidence/runs', async (_req, res) => {
  try {
    res.json({ evidence: await readRunEvidence(PROJECT_DIR) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/documents/formats', async (_req, res) => {
  try {
    const converters = await localDocumentConverters();
    res.json({ formats: { markdown: { available: true }, html: { available: true }, pdf: { available: converters.pandoc, converter: 'pandoc' }, docx: { available: converters.pandoc, converter: 'pandoc' } } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/documents', async (_req, res) => {
  try {
    await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
    const files = await fs.readdir(DOCUMENTS_DIR, { withFileTypes: true });
    const documents: GeneratedDocumentMetadata[] = [];
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(DOCUMENTS_DIR, file.name), 'utf-8')) as GeneratedDocumentMetadata;
        documents.push(metadata);
      } catch { /* ignore corrupt metadata */ }
    }
    documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ documents });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/documents/generate', async (req, res) => {
  try {
    const title = String(req.body?.title || 'Harness Document').trim().slice(0, 160) || 'Harness Document';
    const template = normalizeDocumentTemplate(req.body?.template);
    const format = normalizeDocumentFormat(req.body?.format);
    const sourceLabel = String(req.body?.sourceLabel || 'Harness chat').trim().slice(0, 120) || 'Harness chat';
    const content = String(req.body?.content || '').slice(0, 200_000);
    const evidence = req.body?.evidence && typeof req.body.evidence === 'object' ? req.body.evidence as EvidenceCard : undefined;
    const markdown = buildGeneratedDocumentMarkdown({ title, template, sourceLabel, content, evidence });
    const body = format === 'html' ? markdownToDocumentHtml(markdown, title) : markdown;
    await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${documentSlug(title)}-${crypto.randomBytes(3).toString('hex')}`;
    const extension = format === 'html' ? 'html' : format === 'pdf' ? 'pdf' : format === 'docx' ? 'docx' : 'md';
    const filename = `${id}.${extension}`;
    const filePath = path.join(DOCUMENTS_DIR, filename);
    if (format === 'pdf' || format === 'docx') await convertMarkdownDocument(markdown, filePath, format);
    else await fs.writeFile(filePath, body, 'utf-8');
    const stat = await fs.stat(filePath);
    const metadata: GeneratedDocumentMetadata = { id, title, template, format, filename, createdAt: new Date().toISOString(), sourceLabel, size: stat.size };
    await fs.writeFile(path.join(DOCUMENTS_DIR, `${id}.json`), JSON.stringify(metadata, null, 2), 'utf-8');
    if (evidence) await appendLearningCandidate(PROJECT_DIR, createEvidenceLearningCandidate(metadata, evidence, markdown));
    res.json({ ok: true, document: metadata, content: format === 'pdf' || format === 'docx' ? markdown : body });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/documents/:id/download', async (req, res) => {
  const id = safeLocalId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid document id.' }); return; }
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(DOCUMENTS_DIR, `${id}.json`), 'utf-8')) as GeneratedDocumentMetadata;
    const filePath = path.join(DOCUMENTS_DIR, metadata.filename);
    const raw = await fs.readFile(filePath);
    const contentType = metadata.format === 'html' ? 'text/html; charset=utf-8' : metadata.format === 'pdf' ? 'application/pdf' : metadata.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.filename}"`);
    res.send(raw);
  } catch {
    res.status(404).json({ error: 'Document not found.' });
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
  checkAutonomyExpiry();
  res.json({
    mode: permissionMode,
    allowedModes: ALLOWED_PERMISSION_MODES,
    killSwitch: { active: killSwitchActive, reason: killSwitchReason },
    pendingCount: permissionPrompts.list().length,
    autonomyExpiresAt: autonomyExpiresAt > Date.now() ? new Date(autonomyExpiresAt).toISOString() : null,
    autonomyPreviousMode: autonomyExpiresAt > 0 ? autonomyPreviousMode : null,
  });
});

// Set or clear timed autonomy. When set, permissionMode is changed to dontAsk
// and will auto-revert to the previous mode when the timer expires.
app.post('/api/permissions/timed-autonomy', (req, res) => {
  try {
    const expiresInMinutes = typeof req.body?.expiresInMinutes === 'number' && req.body.expiresInMinutes > 0
      ? Math.min(req.body.expiresInMinutes, 1440) : undefined;
    if (expiresInMinutes) {
      autonomyPreviousMode = permissionMode !== 'dontAsk' ? permissionMode : autonomyPreviousMode || 'default';
      permissionMode = 'dontAsk';
      autonomyExpiresAt = Date.now() + expiresInMinutes * 60_000;
      logger.info('Permissions', 'Timed autonomy engaged', { expiresInMinutes, previousMode: autonomyPreviousMode });
      appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.engaged', reason: `Engaged for ${expiresInMinutes}m, reverts to ${autonomyPreviousMode}` }).catch(() => {});
    } else {
      // Clear timed autonomy (revert now)
      const clearTools = Boolean(req.body?.clearTimedTools);
      if (autonomyExpiresAt > 0) {
        permissionMode = autonomyPreviousMode;
        logger.info('Permissions', 'Timed autonomy cleared, reverted to ' + permissionMode);
        appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.cleared', reason: `Manually cleared, reverted to ${permissionMode}` }).catch(() => {});
      }
      if (clearTools && timedToolEnables.size > 0) {
        timedToolEnables.clear();
        logger.info('Permissions', 'Cleared timed tool enables along with timed autonomy');
      }
      autonomyExpiresAt = 0;
      autonomyPreviousMode = 'default';
    }
    saveSettingsToDisk().catch(() => {});
    res.json({
      permissionMode,
      autonomyExpiresAt: autonomyExpiresAt > Date.now() ? new Date(autonomyExpiresAt).toISOString() : null,
      autonomyPreviousMode: autonomyExpiresAt > 0 ? autonomyPreviousMode : null,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Engage or release the global kill switch. Once engaged, the permission
// engine denies every subsequent tool call until released.
app.post('/api/permissions/kill-switch', (req, res) => {
  try {
    const desired = Boolean(req.body?.active);
    if (desired) {
      killSwitchActive = true;
      killSwitchReason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? String(req.body.reason).trim().slice(0, 500)
        : 'Kill switch engaged from dashboard.';
      // Clear all timed enables and timed autonomy so nothing unlocks during lockdown
      if (timedToolEnables.size > 0) {
        timedToolEnables.clear();
        logger.info('Permissions', 'Cleared timed tool enables due to kill switch');
      }
      if (autonomyExpiresAt > 0) {
        permissionMode = autonomyPreviousMode;
        autonomyExpiresAt = 0;
        autonomyPreviousMode = 'default';
        logger.info('Permissions', 'Cleared timed autonomy due to kill switch, reverted to ' + permissionMode);
      }
      logger.warn('Permissions', 'Kill switch engaged', { reason: killSwitchReason });
      runtimeTracer.recordEvent('permission.kill_switch_engaged', { reason: killSwitchReason });
    } else {
      killSwitchActive = false;
      killSwitchReason = '';
      logger.info('Permissions', 'Kill switch released');
      runtimeTracer.recordEvent('permission.kill_switch_released', {});
    }
    saveSettingsToDisk().catch(() => {});
    res.json({ killSwitch: { active: killSwitchActive, reason: killSwitchReason } });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Read-only registry view for the Tools dashboard. Returns one entry per
// registered tool with risk/category metadata grouped by toolset.
app.get('/api/tools', (_req, res) => {
  try {
    const registry = createBuiltinToolRegistry();
    const tools = registry.listEntries().map((entry) => {
      const name = entry.tool.name;
      const enabled = isToolEnabled(name);
      const timedExpiry = timedToolEnables.get(name);
      const enabledUntil = timedExpiry !== undefined && Date.now() < timedExpiry ? new Date(timedExpiry).toISOString() : undefined;
      return {
        name,
        description: entry.tool.description,
        toolset: entry.toolset,
        source: entry.source,
        enabledByDefault: entry.enabledByDefault,
        enabled,
        enabledUntil,
        isReadOnly: entry.tool.isReadOnly,
        riskLevel: entry.riskLevel,
        permissionCategory: entry.permissionCategory,
        canDryRun: entry.canDryRun,
      };
    });
    const toolsets: Record<string, number> = {};
    for (const tool of tools) toolsets[tool.toolset] = (toolsets[tool.toolset] ?? 0) + 1;
    const capabilities = listCapabilityPolicies();
    res.json({
      tools,
      toolsets,
      disabled: Array.from(disabledTools).sort(),
      capabilities: {
        items: capabilities,
        summary: summarizeCapabilityAlignment(capabilities),
        coverage: mapToolsToCapabilityCoverage(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/capabilities', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    const capabilities = listCapabilityPolicies();
    const activeGrants = listActiveCapabilityGrants(capabilityGrants);
    const expired = findExpiredGrants(capabilityGrants);
    if (expired.length > 0) {
      for (const grant of expired) {
        await appendCapabilityAuditEvent(PROJECT_DIR, { type: 'grant.expired', capabilityId: grant.capabilityId, grantId: grant.id });
        capabilityGrants = revokeCapabilityGrant(capabilityGrants, grant.id);
      }
      await saveSettingsToDisk();
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

app.post('/api/capabilities/grants', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const capabilityId = String(req.body?.capabilityId ?? '').trim();
    const controls = Array.isArray(req.body?.controls) ? req.body.controls : [];
    const result = createCapabilityGrant({
      id: crypto.randomUUID(),
      capabilityId,
      controls,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      expiresInMinutes: req.body?.expiresInMinutes,
    });
    if (!result.grant) {
      const status = result.evaluation.decision === 'deny' ? 403 : 400;
      res.status(status).json({ error: result.evaluation.reason, evaluation: result.evaluation });
      return;
    }
    capabilityGrants = sanitizeCapabilityGrants([...capabilityGrants, result.grant]);
    await saveSettingsToDisk();
    await appendCapabilityAuditEvent(PROJECT_DIR, { type: 'grant.created', capabilityId, grantId: result.grant.id, reason: result.grant.reason });
    logger.info('Capabilities', 'Capability grant created', { capabilityId, grantId: result.grant.id, expiresAt: result.grant.expiresAt });
    res.json({ grant: result.grant, evaluation: result.evaluation, grants: listActiveCapabilityGrants(capabilityGrants) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/capabilities/grants/:id', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const grantId = String(req.params.id ?? '').trim();
    const before = capabilityGrants.find((grant) => grant.id === grantId);
    if (!before) { res.status(404).json({ error: 'Capability grant not found.' }); return; }
    capabilityGrants = revokeCapabilityGrant(capabilityGrants, grantId);
    await saveSettingsToDisk();
    await appendCapabilityAuditEvent(PROJECT_DIR, { type: 'grant.revoked', capabilityId: before.capabilityId, grantId });
    logger.info('Capabilities', 'Capability grant revoked', { capabilityId: before.capabilityId, grantId });
    res.json({ revoked: grantId, grants: listActiveCapabilityGrants(capabilityGrants) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/capabilities/audit', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    const events = await readCapabilityAuditEvents(PROJECT_DIR);
    res.json({ events: events.slice(-200).reverse() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/automations/execute-due', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    if (killSwitchActive) {
      res.status(403).json({ error: 'Kill switch is active.', results: [] });
      return;
    }
    const policy = getAutomationPolicyContext();
    const results = await executeDueJobs(PROJECT_DIR, policy);
    const evidence = [];
    for (const result of results) {
      const card = createRunEvidence({ id: `automation:${result.jobId}:${new Date().toISOString()}`, kind: 'automation', request: result.run.prompt, runName: result.name, command: result.run.scriptOutput ? 'automation script context' : undefined, outputPath: result.run.outputPath, success: true, summary: result.run.scriptOutput.slice(0, 220) });
      await appendRunEvidence(PROJECT_DIR, card);
      evidence.push(card);
    }
    // Notify via Telegram if bot is running.
    if (results.length > 0) {
      const summary = results.map((r) => `• ${r.name}`).join('\n');
      sendTelegramNotification('Automation jobs completed', `${results.length} job(s) ran:\n${summary}`).catch(() => {});
      sendWebhookNotification('automation.completed', { executed: results.length, jobs: results.map((r) => ({ id: r.jobId, name: r.name })) }).catch(() => {});
    }
    res.json({ executed: results.length, results: results.map((r) => ({ jobId: r.jobId, name: r.name, scriptOutput: r.run.scriptOutput, outputPath: r.run.outputPath })), evidence });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/automations/:id/execute', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    if (killSwitchActive) { res.status(403).json({ error: 'Kill switch is active.' }); return; }
    const jobId = safeLocalId(req.params.id);
    if (!jobId) { res.status(400).json({ error: 'Invalid job id.' }); return; }
    const jobs = await listAutomationJobs(PROJECT_DIR);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
    const policy = getAutomationPolicyContext();
    const run = await prepareAutomationRun(PROJECT_DIR, job, new Date(), policy);
    const card = createRunEvidence({ id: `automation:${jobId}:${new Date().toISOString()}`, kind: 'automation', request: run.prompt, runName: job.name, command: run.scriptOutput ? 'automation script context' : undefined, outputPath: run.outputPath, success: true, summary: (run.scriptOutput || '').slice(0, 220) });
    await appendRunEvidence(PROJECT_DIR, card);
    res.json({ ok: true, jobId, name: job.name, scriptOutput: run.scriptOutput, outputPath: run.outputPath, evidence: card });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/automations/jobs', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const name = String(req.body?.name ?? '').trim();
    const prompt = String(req.body?.prompt ?? '').trim();
    const schedule = String(req.body?.schedule ?? '').trim();
    if (!name || !prompt || !schedule) {
      res.status(400).json({ error: 'name, prompt, and schedule are required.' });
      return;
    }
    const scriptCommand = typeof req.body?.scriptCommand === 'string' ? req.body.scriptCommand : undefined;
    const job = await createAutomationJob(PROJECT_DIR, { name, prompt, schedule, scriptCommand });
    logger.info('Automation', 'Job created', { jobId: job.id, name: job.name });
    res.json({ job });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: msg });
  }
});

app.delete('/api/automations/jobs/:id', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const jobId = String(req.params.id ?? '').trim();
    const deleted = await deleteAutomationJob(PROJECT_DIR, jobId);
    if (!deleted) { res.status(404).json({ error: 'Automation job not found.' }); return; }
    logger.info('Automation', 'Job deleted', { jobId });
    res.json({ deleted: jobId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.patch('/api/automations/jobs/:id', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const jobId = String(req.params.id ?? '').trim();
    const updated = await updateAutomationJob(PROJECT_DIR, jobId, req.body ?? {});
    if (!updated) { res.status(404).json({ error: 'Automation job not found.' }); return; }
    logger.info('Automation', 'Job updated', { jobId, name: updated.name });
    res.json({ job: updated });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: msg });
  }
});

app.get('/api/automations/runs', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    const entries = await readAutomationRunLog(PROJECT_DIR);
    const evidence = await readRunEvidence(PROJECT_DIR);
    res.json({ runs: entries, evidence: evidence.filter((card) => card.kind === 'automation') });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/automations/output', async (req, res) => {
  try {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rawPath) { res.status(400).json({ error: 'path is required' }); return; }
    const resolved = path.resolve(PROJECT_DIR, rawPath);
    const automationsDir = path.resolve(PROJECT_DIR, '.harness', 'automations');
    if (!resolved.startsWith(automationsDir)) { res.status(403).json({ error: 'Path must be inside .harness/automations/' }); return; }
    const content = await fs.readFile(resolved, 'utf-8');
    res.json({ path: rawPath, content: content.slice(0, 50_000) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(404).json({ error: msg });
  }
});

// ─── Mycelium graph API ──────────────────────────────────────────
app.get('/api/mycelium', async (_req, res) => {
  try {
    const { loadMyceliumGraph: load } = await import('../mycelium/graph');
    const graph = await load(PROJECT_DIR);
    res.json({
      stats: graph.stats(),
      nodes: graph.listNodes(),
      edges: graph.listEdges(),
      episodes: graph.listEpisodes(20),
      archivedEdges: graph.listArchivedEdges().slice(-20),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Last episode + its selection reasons / route ordering for the UI.
app.get('/api/mycelium/last-route', async (_req, res) => {
  try {
    const { loadMyceliumGraph: load } = await import('../mycelium/graph');
    const graph = await load(PROJECT_DIR);
    const episodes = graph.listEpisodes(1);
    const lastEpisode = episodes[episodes.length - 1] ?? null;
    if (!lastEpisode) {
      res.json({ episode: null, nodes: [], edges: [] });
      return;
    }
    // Hydrate the route's node references and any edges between them.
    const nodes = lastEpisode.route
      .map((id) => graph.getNode(id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n));
    const idSet = new Set(lastEpisode.route);
    const edges = graph.listEdges().filter((e) => idSet.has(e.source) && idSet.has(e.target));
    res.json({ episode: lastEpisode, nodes, edges });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/mycelium', async (_req, res) => {
  try {
    const { MyceliumGraph, saveMyceliumGraph: save } = await import('../mycelium/graph');
    await save(PROJECT_DIR, new MyceliumGraph());
    logger.info('Mycelium', 'Graph reset');
    res.json({ reset: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Apply explicit user feedback (👍 / 👎) to the most recent route. The
// feedback is recorded as a fresh episode tagged with userFeedback so the
// router learns from human judgment, not just the heuristic verifier.
app.post('/api/mycelium/feedback', async (req, res) => {
  const vote = req.body?.vote;
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  if (vote !== 'up' && vote !== 'down' && vote !== 'neutral') {
    res.status(400).json({ error: 'vote must be "up", "down", or "neutral"' });
    return;
  }
  try {
    const router = await createMycelialRouter(PROJECT_DIR);
    // Re-hydrate lastRoute from the most recent episode so feedback works
    // across requests (the chat handler's router instance is per-request).
    const lastEpisode = router.getGraph().listEpisodes(1)[0];
    if (!lastEpisode) {
      res.status(404).json({ error: 'no recent episode to apply feedback to' });
      return;
    }
    // The router doesn't expose setLastRoute; reconstruct via a private cast.
    (router as unknown as { lastRoute: string[] }).lastRoute = lastEpisode.route;
    (router as unknown as { lastQuery: string }).lastQuery = lastEpisode.query;
    const result = router.applyUserFeedback(vote, note);
    await router.save();
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('Mycelium', 'Feedback failed', { error: msg });
    res.status(500).json({ error: msg });
  }
});

// Enable or disable a single tool at runtime. Disabled tools are filtered out
// of the agent's tool list before each chat turn.
// Pass { enabled: true, expiresInMinutes: N } to enable for a limited time.
app.post('/api/tools/:name/toggle', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const toolName = String(req.params.name || '').trim();
    if (!toolName) { res.status(400).json({ error: 'tool name required' }); return; }
    const registry = createBuiltinToolRegistry();
    if (!registry.get(toolName)) { res.status(404).json({ error: 'unknown tool' }); return; }
    const currentlyEnabled = isToolEnabled(toolName);
    const desiredEnabled = req.body?.enabled === undefined ? !currentlyEnabled : Boolean(req.body.enabled);
    const expiresInMinutes = typeof req.body?.expiresInMinutes === 'number' && req.body.expiresInMinutes > 0
      ? Math.min(req.body.expiresInMinutes, 1440) : undefined;

    if (desiredEnabled) {
      if (expiresInMinutes) {
        // Time-limited enable: keep in disabledTools but add timed override
        disabledTools.add(toolName);
        timedToolEnables.set(toolName, Date.now() + expiresInMinutes * 60_000);
      } else {
        // Permanent enable
        disabledTools.delete(toolName);
        timedToolEnables.delete(toolName);
      }
    } else {
      disabledTools.add(toolName);
      timedToolEnables.delete(toolName);
    }
    const timedExpiry = timedToolEnables.get(toolName);
    const enabledUntil = timedExpiry !== undefined && Date.now() < timedExpiry ? new Date(timedExpiry).toISOString() : undefined;
    logger.info('Tools', 'Tool toggled', { tool: toolName, enabled: desiredEnabled, expiresInMinutes });
    saveSettingsToDisk().catch(() => {});
    res.json({ name: toolName, enabled: desiredEnabled, enabledUntil, disabled: Array.from(disabledTools).sort() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Batch enable/disable multiple tools in a single call.
app.post('/api/tools/bulk-toggle', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const names = Array.isArray(req.body?.names) ? req.body.names : [];
    const desiredEnabled = Boolean(req.body?.enabled);
    const expiresInMinutes = typeof req.body?.expiresInMinutes === 'number' && req.body.expiresInMinutes > 0
      ? Math.min(req.body.expiresInMinutes, 1440) : undefined;
    const registry = createBuiltinToolRegistry();
    const results: Array<{ name: string; enabled: boolean; enabledUntil?: string }> = [];
    for (const raw of names) {
      const toolName = String(raw).trim();
      if (!toolName || !registry.get(toolName)) continue;
      if (desiredEnabled) {
        if (expiresInMinutes) {
          disabledTools.add(toolName);
          timedToolEnables.set(toolName, Date.now() + expiresInMinutes * 60_000);
        } else {
          disabledTools.delete(toolName);
          timedToolEnables.delete(toolName);
        }
      } else {
        disabledTools.add(toolName);
        timedToolEnables.delete(toolName);
      }
      const timedExpiry = timedToolEnables.get(toolName);
      const enabledUntil = timedExpiry !== undefined && Date.now() < timedExpiry ? new Date(timedExpiry).toISOString() : undefined;
      results.push({ name: toolName, enabled: desiredEnabled, enabledUntil });
    }
    logger.info('Tools', 'Bulk toggle', { count: results.length, enabled: desiredEnabled, expiresInMinutes });
    saveSettingsToDisk().catch(() => {});
    res.json({ toggled: results, disabled: Array.from(disabledTools).sort() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
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
  try {
    const run = workflowRegistry.getRun(String(req.params.id || ''));
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    res.json({ run });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/workflows/runs/:id/pause', (req, res) => {
  try {
    const ok = workflowRegistry.pause(String(req.params.id || ''), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
    if (!ok) { res.status(409).json({ error: 'run is not running' }); return; }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
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
  try {
    const ok = workflowRegistry.cancel(String(req.params.id || ''), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
    if (!ok) { res.status(409).json({ error: 'run cannot be cancelled' }); return; }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/permissions/:id/resolve', (req, res) => {
  try {
    const promptId = safeLocalId(req.params.id);
    if (!promptId) { res.status(400).json({ error: 'Invalid permission prompt id.' }); return; }
    const allowed = Boolean(req.body?.allowed);
    const resolved = permissionPrompts.resolve(promptId, allowed, req.body?.reason?.toString());
    if (!resolved) { res.status(404).json({ error: 'Permission prompt not found.' }); return; }
    runtimeTracer.recordEvent('permission.prompt_resolved', { promptId, allowed });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Chat endpoint — runs the agent loop and streams events as SSE
app.post('/api/chat', async (req, res) => {
  await ensureSettingsLoaded();
  checkAutonomyExpiry();
  lastUserActivityMs = Date.now();
  const { message, model } = req.body;
  if (!message) { res.status(400).json({ error: 'message is required' }); return; }

  // Best-effort: if the user message contains a trigger phrase from any
  // installed skill, record a use event for that skill so the curator can
  // see real-world relevance, not just explicit `skill` tool calls.
  const messageText = typeof message === 'string' ? message : (typeof (message as { content?: unknown })?.content === 'string' ? (message as { content: string }).content : '');
  if (messageText) {
    loadSkillsDir(SKILLS_DIR)
      .then((skills) => {
        const matched = matchSkillTrigger(skills, messageText);
        if (matched) recordSkillUse(PROJECT_DIR, matched.name).catch(() => {});
      })
      .catch(() => {});
  }

  refreshCapabilityRegistry();

  // Tier 0: Deterministic shortcut — bypass model entirely for simple computations.
  if (messageText) {
    const shortcut = tryDeterministicShortcut(messageText);
    if (shortcut.handled) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const answer = typeof shortcut.output === 'string' ? shortcut.output : JSON.stringify(shortcut.output, null, 2);
      const response = `${answer}\n\n*${shortcut.explanation}*`;
      res.write(`data: ${JSON.stringify({ type: 'text', content: response })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', reason: 'deterministic_shortcut' })}\n\n`);
      emitEvent(PROJECT_DIR, 'system', 'deterministic_shortcut', { type: shortcut.type, input: messageText.slice(0, 100) }, 'system').catch(() => {});
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  const operateResult = messageText ? await handleOperateModeRequest(PROJECT_DIR, messageText, undefined, {
    checkCapabilities: (required) => capabilityRegistry.formatLimitations(required as any[]),
  }) : null;

  // Emit mode classification for every request so the UI can display the
  // detected intent and any suppressed modes.
  if (messageText) {
    const modeClassification = classifyMode(messageText);
    // We don't SSE here yet (headers not sent for non-operate path),
    // but we attach it to the operate result for the operate branch and
    // stash it for the model branch to emit after SSE headers are set.
    (req as any).__modeClassification = modeClassification;
  }

  if (operateResult?.handled) {
    const evidenceCard: EvidenceCard = {
      id: crypto.randomUUID(),
      kind: 'chat',
      mode: 'operate',
      createdAt: new Date().toISOString(),
      request: messageText.slice(0, 500),
      model: model || currentModel || 'deterministic-operate-mode',
      backend: 'local',
      permissionMode,
      capabilityGrantCount: listActiveCapabilityGrants(capabilityGrants).length,
      toolSuccessRate: 1,
      tools: [],
      files: operateResult.service
        ? [
            { path: `${operateResult.service.storage_location}/service.json`, action: 'write' },
            { path: `${operateResult.service.storage_location}/state.json`, action: 'write' },
            { path: '.harness/automations/jobs.json', action: 'write' },
          ]
        : [],
      commands: [],
      artifacts: [],
      recovery: { stopReason: 'completed' },
    };
    await appendRunEvidence(PROJECT_DIR, evidenceCard).catch(() => {});
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'close');
    res.flushHeaders();
    const modeClassification = (req as any).__modeClassification;
    if (modeClassification) {
      res.write(`data: ${JSON.stringify({ type: 'mode_classification', ...modeClassification })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: 'text', content: operateResult.response })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'agentic_mode', mode: 'OPERATE_MODE', classification: operateResult.classification, service: operateResult.service, state: operateResult.state, schedule: operateResult.schedule })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'evidence', evidence: evidenceCard })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', reason: 'completed', turns: 0 })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const activeModel = model || currentModel;
  if (!activeModel) { res.status(400).json({ error: 'No model selected.' }); return; }

  const skipValidationThisTurn = req.body?.skipValidation === true;
  if (process.env.NODE_ENV !== 'test' && !rateLimiter.tryConsume()) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  // Use 'close' rather than 'keep-alive' for SSE: keep-alive on a stream
  // that ends quickly can race with undici's connection reuse on the
  // client side and surface as `TypeError: terminated` mid-body. SSE works
  // fine over a single connection that closes when the stream ends.
  res.setHeader('Connection', 'close');
  res.flushHeaders();

  // Emit mode classification before model loop starts
  const modeClassification = (req as any).__modeClassification;
  if (modeClassification) {
    res.write(`data: ${JSON.stringify({ type: 'mode_classification', ...modeClassification })}\n\n`);
  }

  const abortController = new AbortController();
  // Use res.on('close') instead of req.on('close') on POST SSE routes:
  // req 'close' can fire as soon as the request body is fully consumed,
  // before any SSE event is written, which would abort the stream
  // immediately and surface as `TypeError: terminated` on the client.
  res.on('close', () => {
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

  // In dontAsk mode, auto-grant all gated capabilities for full autonomy
  if (permissionMode === 'dontAsk') {
    const newGrants = autoGrantGatedCapabilities(capabilityGrants);
    if (newGrants.length > 0) {
      capabilityGrants = sanitizeCapabilityGrants([...capabilityGrants, ...newGrants]);
      for (const grant of newGrants) {
        await appendCapabilityAuditEvent(PROJECT_DIR, { type: 'grant.created', capabilityId: grant.capabilityId, grantId: grant.id, reason: 'Auto-granted in dontAsk mode.' });
      }
      await saveSettingsToDisk();
      logger.info('Capabilities', `Auto-granted ${newGrants.length} capability(s) in dontAsk mode`, { capabilities: newGrants.map((g) => g.capabilityId) });
    }
  }

  // Start a new learning session for tracking
  webRuntime.startNewSession();
  // Drain any stale uploads-fallback records so this turn only sees its own.
  drainUploadsFallbacks();

  // Build the file-system rule dynamically so the agent knows about the
  // user-configured Agent Files folder (when set) and the explicit allowed
  // external paths. Without this the agent reflexively says "I can only
  // write inside my project directory" even after the user has explicitly
  // configured a writable folder elsewhere.
  const writableExternals = getAllowedExternalPaths();
  const outputDir = agentOutputDir.trim();
  const outputNote = outputDir
    ? ` New files, scratch artifacts, generated reports, and exploratory outputs should go under this Agent Files output folder unless the user names a different destination: ${outputDir}. Other allowed external folders may be user-owned tools or data stores; do not use them as scratch output sinks unless the user explicitly asks.`
    : '';
  const writableNote = writableExternals.length > 0
    ? `\n6. file_read, file_write, file_edit, file_move, file_delete, and list_files work in the project directory AND in these user-allowed external folders: ${writableExternals.join(', ')}.${outputNote} You can write directly to any path inside those folders when the user asks for that location. Use file_move when the user asks you to move files; do NOT emulate moves with read+write (that leaves the original behind).`
    : `\n6. file_read, file_write, file_edit, file_move, file_delete, and list_files work inside the project directory. To access files outside the project, ask the user to set an Agent Files folder in Settings (it gets auto-added to the allowed-write list); only fall back to bash/dir/cat/type when the user has not configured a folder.`;
  const basePrompt = systemPromptOverride ||
    'You are a self-learning AI assistant with full web access and local tool use. IMPORTANT RULES:\n' +
    '1. When the user asks about something on the web (weather, news, docs, prices, etc.), ALWAYS use web_search to find it, then web_read to fetch the actual content. NEVER just suggest links — fetch the data yourself and show the results.\n' +
    '2. You can read files, write files, edit code, move files, delete files, run commands, search files with grep, search the web, and read web pages.\n' +
    '3. When you notice a reusable pattern, create a skill. When you learn something important, use the remember tool.\n' +
    '4. Format responses in Markdown.\n' +
    '5. Be direct — do the work, don\'t ask the user to do it themselves.' +
    writableNote +
    '\n7. You have a document_export tool that creates CSV, Excel (.xlsx), Word (.docx), and PDF files. If the user asks what formats are available or says Markdown is hard to read, answer with options first. Use document_export only when the user asks you to create or export a specific file. For Excel, numbers and percentages are auto-formatted. Tables are supported in Word and PDF.' +
    '\n8. Use configured communication tools instead of inventing app-local notification config: use telegram_notify for Telegram notifications through the saved Harness Telegram bridge, and email_draft/email_send for email. Do not create .env files with bot tokens or call the raw Telegram HTTP API unless the user explicitly asks for a separate app integration.' +
    '\n9. Treat configured external folders as user-owned data and tools. For existing apps under allowed external folders, use their CLI commands and data files for routine requests. Do not rewrite scripts, setup files, notification formatters, or skill implementations there unless the user explicitly asks you to modify that tool\'s code. For bullet journal task requests, prefer the journal CLI or task data over file_write/file_edit on journal.py, telegram_sender.py, or related program files.';

  // Inject name and personality before the base prompt
  const identityPrefix = [
    agentName ? `Your name is ${agentName}.` : '',
    agentPersonality || '',
  ].filter(Boolean).join(' ');
  const promptWithPersonality = identityPrefix
    ? `${identityPrefix}\n\n${basePrompt}`
    : basePrompt;

  // Use evolved prompt — layers in learned patterns and self-improvements
  const evolvedPrompt = await webRuntime.getEvolvedPrompt(promptWithPersonality);
  const baseSystemPrompt = await webRuntime.assembleSystemContext({ systemPrompt: withRoutingPolicy(evolvedPrompt), projectDir, skillsDir: SKILLS_DIR });
  const attachmentsBlock = await buildAttachmentsContextBlock(req.body?.attachments);

  // Mycelium routing: grow adaptive context from the message
  let myceliumRouter: MycelialContextRouter | null = null;
  let myceliumContext = '';
  let myceliumClassification: ReturnType<MycelialContextRouter['getLastClassification']> = null;
  let myceliumContextPackage: ReturnType<MycelialContextRouter['getLastContextPackage']> = null;
  try {
    myceliumRouter = await createMycelialRouter(PROJECT_DIR);
    // Seed the generic safety / agent / verifier / workflow / prompt nodes
    // exactly once. seedGeneric() is idempotent so this is cheap on repeat.
    myceliumRouter.seedGeneric();
    const tools = webRuntime.getTools();
    myceliumRouter.seedToolNodes(tools.map((t) => ({ name: t.name, description: t.description })));
    // Seed skills from runtime and repo directories
    try {
      const [runtimeSkills, repoSkills] = await Promise.all([
        loadSkillsDir(SKILLS_DIR).catch(() => []),
        loadSkillsDir(REPO_SKILLS_DIR).catch(() => []),
      ]);
      const allSkills = [...runtimeSkills, ...repoSkills];
      myceliumRouter.seedSkillNodes(allSkills.map((s) => ({ name: s.name, description: s.description, domain: s.domain })));
    } catch { /* skill seeding is optional */ }
    // Seed semantic memory entries
    try {
      const memResults = await searchSemanticMemory(PROJECT_DIR, message.slice(0, 200));
      if (memResults.length > 0) {
        myceliumRouter.seedMemoryNodes(memResults.slice(0, 10).map((r) => ({ id: r.entry.id, text: r.entry.text, kind: r.entry.kind })));
      }
    } catch { /* memory seeding is optional */ }
    const myceliumResult = myceliumRouter.routeQueryRich(message);
    myceliumClassification = myceliumResult.classification;
    myceliumContextPackage = myceliumResult.contextPackage;
    if (myceliumResult.nodes.length > 0) {
      const safetyBlock = myceliumResult.contextPackage.safety_notes.length > 0
        ? '\n[Safety notes]\n  - ' + myceliumResult.contextPackage.safety_notes.join('\n  - ')
        : '';
      myceliumContext =
        `\n\n--- Mycelium context (adaptive routing) ---\n` +
        `[Task type: ${myceliumResult.classification.type}; high_risk: ${myceliumResult.classification.highRisk}; exploration: ${myceliumResult.classification.explorationRate}]\n` +
        myceliumResult.contextText +
        safetyBlock;
    }
  } catch (error) {
    logger.warn('Mycelium', 'Context routing failed', { error: error instanceof Error ? error.message : String(error) });
  }

  // Nervous System: inspect query, evaluate reflexes, calculate attention
  globalNervousSystem.reset();
  const nervousResult = globalNervousSystem.inspectQuery(messageText, myceliumClassification?.type ?? 'general');
  let nervousContext = '';

  // Code Intelligence: inject compact repo awareness into the system prompt
  let codeIntelContext = '';
  try {
    const repoGraph = await loadRepoGraph(PROJECT_DIR);
    if (repoGraph) {
      const repoSummary = summarizeRepo(repoGraph);
      if (repoSummary.total_files > 0) {
        const topFiles = repoSummary.most_imported.slice(0, 8).map((f) => `  ${f.file} (${f.count} importers)`).join('\n');
        codeIntelContext = `\n\n--- Code Intelligence ---\nRepo: ${repoSummary.total_files} files, ${repoSummary.total_edges} dependency edges, ${repoSummary.test_files} test files.\nKey files (most imported):\n${topFiles}`;
      }
    }
  } catch { /* code intel is optional */ }
  if (nervousResult.runState.safetyNotes.length > 0) {
    nervousContext = '\n\n--- Nervous System ---\n' + nervousResult.runState.safetyNotes.map((n) => `⚠️ ${n}`).join('\n');
  }
  if (nervousResult.recoveryPlan) {
    const { formatRecoveryPlan } = await import('../nervous/recovery');
    nervousContext += '\n' + formatRecoveryPlan(nervousResult.recoveryPlan);
  }

  const toolSynthesisNudge = `IMPORTANT: After using tools, you MUST always provide a final text response summarizing your findings. Never end your turn with only tool calls and no text output. If you have gathered enough information, stop calling tools and write your answer.

TOOL USE RULES (critical):
- When the user asks about current events, news, weather, prices, scores, or anything that changes over time, you MUST call web_search first. Do NOT answer from your training data — it is outdated.
- When the user asks "what's in the news" or similar, call web_search with a relevant query like "latest news today" and then summarize the results.
- Your training data has a knowledge cutoff. For anything recent, ALWAYS search first.

AUTONOMY RULES (critical):
- When the user gives you a task, complete it FULLY. Do not stop partway through.
- Do NOT present numbered options and ask the user to choose. Just do ALL of them.
- Do NOT ask "would you like me to continue?" or "shall I proceed?" — JUST CONTINUE.
- If a directory has multiple files, read ALL of them. Do not stop after one.
- If analysis has multiple steps, do ALL steps. Do not summarize step 1 and ask about step 2.
- If you discover related work while doing a task, do it immediately.
- The ONLY reason to stop is when the task is genuinely, fully complete.
- When in doubt, DO MORE rather than asking.

TOOL FALLBACK RULES:
- If web_read or web_fetch returns HTTP 403/429/500, do NOT retry the same site. Try a different URL or use browser_navigate instead (Playwright-based, handles JavaScript and anti-bot pages).
- If a site blocks you (Cloudflare, rate limit), move on to other sources. Do not waste turns retrying blocked sites.
- You have browser_navigate, browser_read, browser_click tools available for sites that block simple HTTP requests.
- Prefer web_search + web_read for initial research, fall back to browser_navigate for blocked sites.`;

  const systemPrompt = [baseSystemPrompt, attachmentsBlock, myceliumContext, codeIntelContext, nervousContext, toolSynthesisNudge].filter(Boolean).join('\n\n');

  const synthesisStats = await loadSynthesisStats(PROJECT_DIR);
  const effectiveMaxTurns = adaptiveMaxTurns(synthesisStats, activeModel, 25);

  // Wall-clock budget: local Ollama models are slow per-turn so a generous
  // turn budget hammers the GPU. Cloud APIs are fast so they can afford
  // more turns. Use a time budget that naturally throttles local inference
  // while preserving full agentic capability on cloud backends.
  // User-configured timeBudgetMs (from Settings) overrides the auto-detect.
  const chatBackend = activeModel.includes('/') ? activeModel.slice(0, activeModel.indexOf('/')) : 'ollama';
  const isLocalBackend = chatBackend === 'ollama' && !activeModel.includes('cloud');
  const defaultBudgetMs = isLocalBackend ? 180_000 : 600_000;
  const effectiveTimeBudgetMs = timeBudgetMs > 0 ? timeBudgetMs : adaptiveTimeBudget(synthesisStats, activeModel, defaultBudgetMs);

  const config: LoopConfig = {
    model: activeModel,
    systemPrompt,
    maxTurns: effectiveMaxTurns,
    maxTimeMs: effectiveTimeBudgetMs,
    abortSignal: abortController.signal,
    context: { maxTokens: activeContextMaxTokens, summarizerModel },
    outputValidation: {
      enabled: activeOutputValidation.enabled,
      profile: activeOutputValidation.profile,
      customProfiles: customOutputValidationProfiles,
    },
    autoContinue: true,
    taskType: myceliumClassification?.type,
  };

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 15_000);
  keepAlive.unref?.();
  const session = webRuntime.createSession(projectDir, activeModel);
  // Guard setMeta with a typeof check so the handler tolerates partial
  // session mocks in tests (real SessionStorage always implements setMeta).
  if (agentName && typeof session.setMeta === 'function') session.setMeta('agentName', agentName);
  if (agentAvatar && typeof session.setMeta === 'function') session.setMeta('agentAvatar', agentAvatar);
  await session.initialize();

  const deps: QueryLoopDeps = {
    client,
    tools,
    permissionCheck: async (call) => {
      // Browser page tools require an active browser-page-access grant
      const BROWSER_PAGE_TOOLS = new Set(['browser_navigate', 'browser_click', 'browser_fill', 'browser_read', 'browser_screenshot', 'browser_close']);
      if (BROWSER_PAGE_TOOLS.has(call.name)) {
        const evaluation = evaluateCapabilityGrant('browser-page-access', capabilityGrants, { killSwitchActive });
        if (evaluation.decision !== 'allow') {
          return { allowed: false, reason: `Browser page tools require an active browser-page-access grant. ${evaluation.reason}` };
        }
      }
      const motor = globalNervousSystem.checkToolPermission(call.name, call.input);
      runtimeTracer.recordEvent('nervous.motor_decision', { tool: call.name, decision: motor.decision, reason: motor.reason });
      if (motor.decision === 'BLOCK' || motor.decision === 'INTERRUPT_AND_RECOVER') {
        return { allowed: false, reason: `Nervous System ${motor.decision}: ${motor.reason}` };
      }
      if (motor.decision === 'ALLOW_DRY_RUN_ONLY' && !hasDryRunIntent(call.input)) {
        return { allowed: false, reason: `Nervous System requires dry-run for '${call.name}': ${motor.reason}` };
      }
      if (motor.decision === 'REQUIRE_VERIFICATION') {
        if (shouldBypassNervousVerification()) {
          runtimeTracer.recordEvent('nervous.verification_bypassed', { tool: call.name, reason: motor.reason, permissionMode });
          return { allowed: true, reason: `Nervous System verification bypassed for '${call.name}' in auto-approve mode: ${motor.reason}` };
        }
        runtimeTracer.recordEvent('permission.prompt_created', { tool: call.name, reason: motor.reason, source: 'nervous.verification' });
        return permissionPrompts.request(call, `Nervous System requires verification: ${motor.reason}`);
      }
      if (motor.decision === 'REQUIRE_CONFIRMATION') {
        if (permissionMode === 'dontAsk') {
          return { allowed: false, reason: `Nervous System requires confirmation for '${call.name}' while permission mode is dontAsk: ${motor.reason}` };
        }
        runtimeTracer.recordEvent('permission.prompt_created', { tool: call.name, reason: motor.reason, source: 'nervous.motor' });
        return permissionPrompts.request(call, `Nervous System requires confirmation: ${motor.reason}`);
      }
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
  // Last output_validation event seen during the run. Used to feed the
  // mycelium heuristic verifier with a real-validator signal so reinforcement
  // reflects ground truth rather than text-shape heuristics alone.
  let lastValidationStatus: 'pass' | 'warn' | 'fail' | undefined;
  let lastValidationScore: number | undefined;
  let toolCallCount = 0;
  let toolSuccessCount = 0;
  const toolCallSequence: string[] = [];
  const evidenceTools: EvidenceToolSummary[] = [];
  const evidenceFiles: EvidenceFileSummary[] = [];
  const evidenceCommands: EvidenceCard['commands'] = [];
  let lastValidation: EvidenceCard['validation'];
  let doneReason: string | undefined;
  let autoContinueCount = 0;
  let turnCount = 0;
  let totalTurnMs = 0;
  // Per-tool success/total counters so the verifier can spot silent failures
  // in failure-prone tools (web_fetch, pdf_*) that the aggregate ratio dilutes.
  const toolStats = new Map<string, { success: number; total: number }>();

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
      if (event.type === 'tool_result') {
        toolCallCount++;
        if (event.result?.success) toolSuccessCount++;
        // Nervous System: inspect tool result
        globalNervousSystem.onToolResult(event.call.name, Boolean(event.result?.success), String(event.result?.output ?? ''));
        globalNervousSystem.onToolCallSequence(toolCallSequence);
        evidenceTools.push({
          name: event.call.name,
          success: Boolean(event.result?.success),
          inputSummary: summarizeForEvidence(event.call.input),
          outputSummary: summarizeForEvidence(event.result?.output),
        });
        evidenceFiles.push(...evidenceFilesFromTool(event.call.name, event.call.input));
        if (event.call.name === 'bash' && typeof event.call.input.command === 'string') {
          evidenceCommands.push({ command: event.call.input.command, success: Boolean(event.result?.success), outputSummary: summarizeForEvidence(event.result?.output) });
        }
        if (event.call?.name) {
          toolCallSequence.push(event.call.name);
          const stats = toolStats.get(event.call.name) ?? { success: 0, total: 0 };
          stats.total++;
          if (event.result?.success) stats.success++;
          toolStats.set(event.call.name, stats);
        }
        // Event store: emit per-tool events for audit trail + postmortem analysis.
        emitEvent(PROJECT_DIR, 'tool', event.result?.success ? 'tool_succeeded' : 'tool_failed', {
          tool: event.call.name,
          input_summary: summarizeForEvidence(event.call.input)?.slice(0, 200),
          output_summary: summarizeForEvidence(event.result?.output)?.slice(0, 200),
          session_id: session.getSessionId(),
        }, 'agent', session.getSessionId()).catch(() => {});
        // Schema validation: validate tool call arguments against matching schema.
        const toolSchema = detectSchema({ toolName: event.call.name });
        if (toolSchema && event.call.input && typeof event.call.input === 'object') {
          const schemaResult = validateStructuredOutput(event.call.input as Record<string, unknown>, toolSchema);
          if (!schemaResult.valid) {
            emitEvent(PROJECT_DIR, 'tool', 'schema_validation_failed', {
              tool: event.call.name,
              schema: schemaResult.schema_id,
              errors: schemaResult.errors.slice(0, 5),
              score: schemaResult.score,
            }, 'agent', session.getSessionId()).catch(() => {});
          }
        }
      }
      if (event.type === 'output_validation') {
        lastValidation = event.validation;
        lastValidationStatus = event.validation.status as 'pass' | 'warn' | 'fail';
        lastValidationScore = event.validation.score;
        await recordOutputValidationEvalRun(PROJECT_DIR, event.validation, message.slice(0, 120), {
          selectionSource: activeOutputValidation.selectionSource,
          selectionReason: activeOutputValidation.selectionReason,
        });
      }
      if (event.type === 'text' && typeof event.content === 'string') {
        assistantTextBuffer += event.content;
      }
      if (event.type === 'done') {
        doneReason = event.reason;
        recordSessionCompleted(PROJECT_DIR, activeModel).catch(() => {});
        // Record average turn duration for adaptive time budget.
        if (turnCount > 0) {
          recordAvgTurnDuration(PROJECT_DIR, activeModel, Math.round(totalTurnMs / turnCount)).catch(() => {});
        }
      }
      if (event.type === 'turn_complete') {
        turnCount++;
        totalTurnMs += (event as { durationMs?: number }).durationMs ?? 0;
      }
      if (event.type === 'synthesis_fired') {
        recordSynthesisFired(PROJECT_DIR, activeModel).catch(() => {});
      }
      if (event.type === 'auto_continue') {
        autoContinueCount++;
        recordSessionAutoContinue(activeModel);
      }
      for (const fallbackEvent of drainRemoteProviderFallbackEvents()) {
        res.write(`data: ${JSON.stringify(fallbackEvent)}\n\n`);
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
    for (const fallbackEvent of drainRemoteProviderFallbackEvents()) {
      res.write(`data: ${JSON.stringify(fallbackEvent)}\n\n`);
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
  } finally {
    clearInterval(keepAlive);
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

  // Mycelium reinforcement: strengthen or weaken routes based on outcome.
  // Run a heuristic verifier first so the reward reflects safety + tool reliability.
  let nsPainMultiplier = 1.0;
  if (myceliumRouter) {
    const hasOutput = assistantTextBuffer.trim().length > 0;
    const toolSuccessRate = toolCallCount > 0 ? toolSuccessCount / toolCallCount : 0.5;
    let verifierScore = 0.5;
    let verifierBlocked = false;
    let verifierBlockReason: string | undefined;
    let verifierAppliedVerifiers: string[] = [];
    if (myceliumContextPackage) {
      try {
        // Build per-tool success ratios for high-cost / failure-prone tools.
        // The verifier uses the worst ratio to pull tool_reliability down so
        // silent web/pdf failures aren't masked by an otherwise-healthy run.
        const TRACKED_TOOLS = ['web_fetch', 'pdf_read', 'pdf_metadata', 'pdf_render_page', 'pdf_extract_tables'];
        const toolSuccessRatios: Record<string, number> = {};
        for (const tool of TRACKED_TOOLS) {
          const stats = toolStats.get(tool);
          if (stats && stats.total > 0) toolSuccessRatios[tool] = stats.success / stats.total;
        }
        const realSignals = (lastValidationScore !== undefined || Object.keys(toolSuccessRatios).length > 0)
          ? {
              outputValidationScore: lastValidationScore,
              outputValidationStatus: lastValidationStatus,
              toolSuccessRatios: Object.keys(toolSuccessRatios).length > 0 ? toolSuccessRatios : undefined,
            }
          : undefined;
        const v = heuristicVerifier({
          response: assistantTextBuffer,
          contextPackage: myceliumContextPackage,
          toolCallCount,
          toolSuccessCount,
          errored: !hasOutput,
          realSignals,
        });
        verifierScore = v.score;
        verifierAppliedVerifiers = v.appliedVerifiers;
        if (v.failedHardCheck) {
          verifierBlocked = true;
          // Compose a short reason from the most relevant note.
          verifierBlockReason = v.notes.find((n) => /fail|hard|irreversible/i.test(n)) ?? v.notes[0] ?? 'verifier_hard_check';
          logger.warn('Mycelium', 'Heuristic verifier failed hard safety check', { notes: v.notes, blockReason: verifierBlockReason });
        }
      } catch { /* verifier is optional */ }
    }
    // Nervous System: inspect verifier result and extract pain
    const nervousVerifier = globalNervousSystem.onVerifierResult(
      verifierBlocked ? 'fail' : 'pass',
      verifierScore,
      verifierBlocked && verifierBlockReason ? [verifierBlockReason] : undefined,
    );
    const nsPainResult = nervousVerifier.painMultiplier;
    nsPainMultiplier = nsPainResult;

    myceliumRouter.reinforce({
      taskSuccess: (hasOutput ? 0.7 : 0.2) * nsPainMultiplier,
      correctness: (hasOutput ? 0.6 + toolSuccessRate * 0.3 : 0.1) * nsPainMultiplier,
      usefulness: (hasOutput ? 0.5 + toolSuccessRate * 0.3 : 0.1) * nsPainMultiplier,
      costEfficiency: toolCallCount <= 5 ? 0.8 : toolCallCount <= 15 ? 0.5 : 0.2,
      userSatisfaction: verifierScore * nsPainMultiplier,
    }, {
      blocked: verifierBlocked,
      blockReason: verifierBlockReason,
      appliedVerifiers: verifierAppliedVerifiers,
    });
    // Auto-create edges between consecutive tools in the call sequence.
    // Tag with origin='sequence' + relation='sequence_learning' so the UI
    // can distinguish learned tool chains from human-seeded edges.
    const graph = myceliumRouter.getGraph();
    for (let i = 0; i < toolCallSequence.length - 1; i++) {
      const srcId = `tool.${toolCallSequence[i]}`;
      const tgtId = `tool.${toolCallSequence[i + 1]}`;
      if (graph.getNode(srcId) && graph.getNode(tgtId)) {
        graph.addEdge(srcId, tgtId, 0.3, { relation: 'sequence_learning', origin: 'sequence' });
      }
    }
    myceliumRouter.decay();
    // Await the graph write so callers (and integration tests) that read
    // /api/mycelium/last-route immediately after the chat completes see
    // the just-recorded episode rather than racing the disk flush.
    try {
      await myceliumRouter.save();
    } catch (error) {
      logger.warn('Mycelium', 'Failed to save graph', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Persist nervous system signals for historical analysis.
  globalNervousSystem.persistSignals(PROJECT_DIR).catch(() => {});

  const evidenceCard: EvidenceCard = {
    id: crypto.randomUUID(),
    kind: 'chat',
    mode: detectEvidenceMode(messageText),
    createdAt: new Date().toISOString(),
    request: messageText.slice(0, 500),
    model: activeModel,
    backend: activeModel.includes('/') ? activeModel.slice(0, activeModel.indexOf('/')) : 'ollama',
    permissionMode,
    capabilityGrantCount: listActiveCapabilityGrants(capabilityGrants).length,
    toolSuccessRate: toolCallCount > 0 ? toolSuccessCount / toolCallCount : undefined,
    tools: evidenceTools,
    files: evidenceFiles,
    commands: evidenceCommands,
    validation: lastValidation,
    mycelium: myceliumRouter ? {
      taskType: myceliumClassification?.type,
      highRisk: myceliumClassification?.highRisk,
      route: myceliumRouter.getLastRoute(),
      protectedEdges: myceliumRouter.getLastExplanation()?.protectedRequired.length,
      selectionReasons: myceliumRouter.getLastExplanation()?.whySelected.reduce<Record<string, string>>((acc, reason, index) => ({ ...acc, [`reason${index + 1}`]: reason }), {}),
    } : undefined,
    artifacts: [],
    recovery: {
      sessionId: session.getSessionId(),
      stopReason: doneReason,
      ...(nervousResult.reflexesTriggered.length > 0 ? {
        nervousReflexes: nervousResult.reflexesTriggered.join(', '),
        nervousRisk: nervousResult.runState.riskLevel,
        nervousPainMultiplier: typeof nsPainMultiplier === 'number' ? nsPainMultiplier : 1.0,
      } : {}),
    },
  };
  res.write(`data: ${JSON.stringify({ type: 'evidence', evidence: evidenceCard })}\n\n`);

  // Promise detection: scan assistant output for commitment language and auto-record promises.
  if (assistantTextBuffer.trim()) {
    const commitments = detectCommitments(assistantTextBuffer);
    for (const commitment of commitments) {
      createPromise(PROJECT_DIR, commitment, { session_id: session.getSessionId() })
        .then((p) => {
          emitEvent(PROJECT_DIR, 'promise', 'promise_auto_detected', { promise_id: p.promise_id, commitment }, 'agent', p.promise_id).catch(() => {});
          logger.info('Promises', `Auto-detected commitment: ${commitment.slice(0, 80)}`);
        })
        .catch(() => {});
    }
  }

  // Schema validation: validate JSON blocks in assistant output text.
  if (assistantTextBuffer.includes('```json') || assistantTextBuffer.includes('```{')) {
    const taskType = myceliumClassification?.type;
    const textSchema = detectSchema({ taskType: taskType === 'coding' ? 'plan' : taskType === 'research' ? 'review' : undefined });
    if (textSchema) {
      const { validation } = parseAndValidate(assistantTextBuffer, textSchema);
      if (!validation.valid) {
        emitEvent(PROJECT_DIR, 'system', 'output_schema_validation_failed', {
          schema: validation.schema_id,
          errors: validation.errors.slice(0, 5),
          score: validation.score,
          session_id: session.getSessionId(),
        }, 'agent', session.getSessionId()).catch(() => {});
      }
    }
  }

  // Event store: record chat turn completion.
  emitEvent(PROJECT_DIR, 'system', 'chat_turn_completed', {
    session_id: session.getSessionId(),
    model: activeModel,
    tool_calls: toolCallCount,
    tool_success: toolSuccessCount,
    done_reason: doneReason,
    has_output: assistantTextBuffer.trim().length > 0,
  }, 'agent', session.getSessionId()).catch(() => {});

  // Execution Readiness Gate: compute and emit readiness score for this turn.
  const readinessInput: ReadinessInput = {
    model_confidence: lastValidationScore !== undefined ? lastValidationScore : undefined,
    verifier_score: typeof nsPainMultiplier === 'number' ? Math.max(0, 1 - (1 - nsPainMultiplier)) : undefined,
    risk_score: myceliumClassification?.highRisk ? 0.8 : 0.2,
    tool_reliability: toolCallCount > 0 ? toolSuccessCount / toolCallCount : undefined,
  };
  const readiness = calculateReadiness(readinessInput);
  res.write(`data: ${JSON.stringify({ type: 'readiness', score: readiness.score, decision: readiness.decision, components: readiness.components, reasons: readiness.reasons })}\n\n`);

  // Readiness-driven escalation: when score is low, suggest model upgrade for next turn.
  if (readiness.decision === 'escalate' && activeModel) {
    const modelBackend = activeModel.includes('/') ? activeModel.slice(0, activeModel.indexOf('/')) : 'ollama';
    if (modelBackend === 'ollama' || !activeModel.includes('cloud')) {
      // Find a stronger configured backend
      const strongBackends = ['anthropic', 'openai', 'github'].filter((b) => {
        const preset = OPENAI_COMPATIBLE_PRESETS[b];
        return preset && readApiKey(preset);
      });
      if (strongBackends.length > 0) {
        const suggested = `${strongBackends[0]}/${OPENAI_COMPATIBLE_PRESETS[strongBackends[0]].defaultModel}`;
        res.write(`data: ${JSON.stringify({ type: 'escalation_advisory', currentModel: activeModel, suggestedModel: suggested, readinessScore: readiness.score, reason: 'Readiness score below threshold. Consider switching to a stronger model.' })}\n\n`);
        emitEvent(PROJECT_DIR, 'model', 'escalation_suggested', { current: activeModel, suggested, readiness_score: readiness.score }, 'system').catch(() => {});
      }
    }
  }

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
    const evidence = await readRunEvidence(PROJECT_DIR, 200);
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
    res.json({ runs, total: runs.length, counts, evidence });
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

// --- API: MCP catalog + local runtime manager ---
// The catalog stays static and offline-friendly. Runtime definitions are
// persisted locally and started only behind the existing arbitrary-shell
// capability grant because MCP servers are external processes.

app.get('/api/mcp/catalog', (_req, res) => {
  res.json({ catalog: MCP_CATALOG });
});

app.get('/api/mcp/runtime', async (_req, res) => {
  try {
    res.json({ servers: await listMcpServers(PROJECT_DIR) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/mcp/runtime/servers', async (req, res) => {
  try {
    const server = await upsertMcpServer(PROJECT_DIR, req.body ?? {});
    res.json({ server, servers: await listMcpServers(PROJECT_DIR) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/mcp/runtime/from-catalog', async (req, res) => {
  try {
    const catalogName = safeLocalId(req.body?.name);
    if (!catalogName) { res.status(400).json({ error: 'Invalid MCP catalog name.' }); return; }
    const entry = MCP_CATALOG.find((item) => item.name === catalogName);
    if (!entry) { res.status(404).json({ error: 'MCP catalog entry not found.' }); return; }
    const existing = (await listMcpServers(PROJECT_DIR)).find((server) => server.id === catalogName);
    if (existing && req.body?.overwrite !== true) {
      res.status(409).json({ error: 'MCP runtime server already exists. Pass overwrite=true to replace it.' });
      return;
    }
    const parsed = parseMcpInstallCommand(entry.install);
    const server = await upsertMcpServer(PROJECT_DIR, {
      id: catalogName,
      catalogName: entry.name,
      command: parsed.command,
      args: parsed.args,
      env: Object.fromEntries((entry.requiresEnv || []).map((key) => [key, ''])),
      tools: [],
      enabled: true,
    });
    res.json({ server, servers: await listMcpServers(PROJECT_DIR), requiresEnv: entry.requiresEnv });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/mcp/runtime/servers/:id', async (req, res) => {
  try {
    const removed = await removeMcpServer(PROJECT_DIR, req.params.id);
    if (!removed) { res.status(404).json({ error: 'MCP server not found.' }); return; }
    res.json({ ok: true, servers: await listMcpServers(PROJECT_DIR) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/mcp/runtime/servers/:id/start', async (req, res) => {
  try {
    await ensureSettingsLoaded();
    const evaluation = evaluateCapabilityGrant('arbitrary-shell', capabilityGrants, { killSwitchActive });
    if (evaluation.decision !== 'allow') {
      res.status(403).json({ error: `MCP server start blocked by arbitrary-shell: ${evaluation.reason}`, evaluation });
      return;
    }
    const server = await startMcpServer(PROJECT_DIR, req.params.id);
    await appendCapabilityAuditEvent(PROJECT_DIR, { type: 'mcp_server.started', serverId: server.id, command: server.command });
    res.json({ server, servers: await listMcpServers(PROJECT_DIR) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/mcp/runtime/servers/:id/stop', async (req, res) => {
  try {
    const stopped = await stopMcpServer(req.params.id);
    await appendCapabilityAuditEvent(PROJECT_DIR, { type: 'mcp_server.stopped', serverId: String(req.params.id ?? '') });
    res.json({ stopped, servers: await listMcpServers(PROJECT_DIR) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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
    const [runtime, repo] = await Promise.all([
      scanSkillsDir(SKILLS_DIR),
      scanSkillsDir(REPO_SKILLS_DIR),
    ]);
    res.json({
      skills: runtime.skills.map(mapSkillForApi('runtime')),
      diagnostics: runtime.diagnostics,
      sources: [
        skillSourceForApi('runtime', 'Runtime skills', SKILLS_DIR, runtime, true),
        skillSourceForApi('repo', 'Repo skills', REPO_SKILLS_DIR, repo, false),
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
    invalidateSkillsCache();
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Skill not found' }); }
});

// Install a read-only repo skill (.github/skills/<name>) into runtime (.harness/skills/<name>).
app.post('/api/skills/install', async (req, res) => {
  const skillName = safeLocalId(req.body?.name);
  if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
  const overwrite = Boolean(req.body?.overwrite);
  try {
    const sourceScan = await scanSkillsDir(REPO_SKILLS_DIR);
    const sourceSkill = sourceScan.skills.find((s) => skillFolderId(s) === skillName || s.name === skillName);
    if (!sourceSkill) {
      const directSourceDir = path.join(REPO_SKILLS_DIR, skillName);
      const directSourceStat = await fs.stat(directSourceDir).catch(() => null);
      if (directSourceStat?.isDirectory()) {
        res.status(400).json({ error: 'Source skill is malformed and cannot be installed. Fix SKILL.md frontmatter first.' });
        return;
      }
      res.status(404).json({ error: 'Source skill not found in .github/skills.' });
      return;
    }
    const sourceDir = path.dirname(sourceSkill.filePath);
    const destinationId = skillFolderId(sourceSkill);
    const destDir = path.join(SKILLS_DIR, destinationId);
    const sourceStat = await fs.stat(sourceDir).catch(() => null);
    if (!sourceStat || !sourceStat.isDirectory()) {
      res.status(404).json({ error: 'Source skill not found in .github/skills.' });
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
    invalidateSkillsCache();
    res.json({ ok: true, id: destinationId, name: sourceSkill.name, source: sourceDir, destination: destDir, overwrote: Boolean(destStat) });
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
    invalidateSkillsCache();
    res.json({ ok: true, name: skillName, filePath: skillFile });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/skills/create', async (req, res) => {
  const skillName = safeLocalId(req.body?.name);
  if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
  const overwrite = req.body?.overwrite === true;
  const skillDir = path.join(SKILLS_DIR, skillName);
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    const existing = await fs.stat(skillFile).catch(() => null);
    if (existing && !overwrite) {
      res.status(409).json({ error: 'Runtime skill already exists. Pass overwrite=true to replace it.' });
      return;
    }
    await fs.mkdir(skillDir, { recursive: true });
    const scaffold = buildRuntimeSkillFile({
      name: skillName,
      description: sanitizeSkillText(req.body?.description, 'Describe what this skill does.', 500),
      domain: sanitizeSkillText(req.body?.domain, 'general', 120),
      triggers: sanitizeSkillList(req.body?.triggers, 20, 120),
      whenToUse: sanitizeSkillText(req.body?.whenToUse, '', 800),
      requiredTools: sanitizeSkillList(req.body?.requiredTools, 40, 80),
      riskLevel: sanitizeSkillRiskLevel(req.body?.riskLevel),
      body: sanitizeSkillBody(req.body?.content),
    });
    await fs.writeFile(skillFile, scaffold, 'utf-8');
    invalidateSkillsCache();
    res.json({ ok: true, name: skillName, filePath: skillFile, overwritten: Boolean(existing) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/skills/automation/repair', async (_req, res) => {
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const [runtime, repo] = await Promise.all([
      scanSkillsDir(SKILLS_DIR),
      scanSkillsDir(REPO_SKILLS_DIR),
    ]);
    const runtimeNames = new Set(runtime.skills.map((skill) => skill.name));
    const runtimeIds = new Set(runtime.skills.map(skillFolderId));
    const installed: Array<{ id: string; name: string; source: string; destination: string }> = [];
    const scaffolded: Array<{ id: string; filePath: string }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const skill of repo.skills) {
      const id = skillFolderId(skill);
      const destination = path.join(SKILLS_DIR, id);
      const destinationExists = await fs.stat(destination).catch(() => null);
      if (runtimeNames.has(skill.name) || runtimeIds.has(id) || destinationExists) {
        skipped.push({ id, reason: 'runtime skill already exists' });
        continue;
      }
      await fs.cp(path.dirname(skill.filePath), destination, { recursive: true });
      installed.push({ id, name: skill.name, source: path.dirname(skill.filePath), destination });
      runtimeNames.add(skill.name);
      runtimeIds.add(id);
    }

    for (const diagnostic of runtime.diagnostics) {
      if (diagnostic.reason !== 'missing-skill-file') {
        skipped.push({ id: diagnostic.name, reason: `manual repair required: ${diagnostic.reason}` });
        continue;
      }
      const id = safeLocalId(diagnostic.name);
      if (!id) {
        skipped.push({ id: diagnostic.name, reason: 'invalid runtime skill folder name' });
        continue;
      }
      const skillDir = path.join(SKILLS_DIR, id);
      const skillFile = path.join(skillDir, 'SKILL.md');
      const existing = await fs.stat(skillFile).catch(() => null);
      if (existing) {
        skipped.push({ id, reason: 'SKILL.md already exists' });
        continue;
      }
      const scaffold = `---\nname: ${id}\ndescription: Describe what this skill does.\ndomain: general\ntriggers: []\n---\n\n# ${id}\n\nDescribe how to use this skill here.\n`;
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillFile, scaffold, 'utf-8');
      scaffolded.push({ id, filePath: skillFile });
    }

    if (installed.length > 0 || scaffolded.length > 0) invalidateSkillsCache();
    res.json({ ok: true, installed, scaffolded, skipped });
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
    let archived: string[] = [];
    try {
      const archiveDir = path.join(SKILLS_DIR, '_archive');
      const entries = await fs.readdir(archiveDir, { withFileTypes: true });
      archived = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch { /* archive dir does not exist yet */ }
    res.json({
      settings: curatorSettings,
      lastUserActivityAt: new Date(lastUserActivityMs).toISOString(),
      schedulerRunning: Boolean(curatorScheduler),
      log,
      proposals,
      archived,
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

// Return the last LLM phase output as a structured proposal list. UI uses
// this to render Approve / Dismiss buttons per cluster instead of asking the
// user to read raw markdown.
app.get('/api/curator/proposals', async (_req, res) => {
  try {
    const raw = await readCuratorProposals(PROJECT_DIR);
    const proposals = raw ? parseMergeProposals(raw) : [];
    res.json({ proposals, raw });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Apply a single merge proposal: writes a new umbrella SKILL.md and archives
// the source skills (pinned ones are skipped). Body: { proposal, umbrellaName?, description?, dryRun? }.
app.post('/api/curator/proposals/apply', async (req, res) => {
  const proposal = req.body?.proposal;
  if (!proposal || !Array.isArray(proposal.mergeSkills) || proposal.mergeSkills.length < 2) {
    res.status(400).json({ error: 'proposal must include at least 2 mergeSkills' });
    return;
  }
  const opts = {
    umbrellaName: typeof req.body?.umbrellaName === 'string' ? req.body.umbrellaName : undefined,
    description: typeof req.body?.description === 'string' ? req.body.description : undefined,
    dryRun: Boolean(req.body?.dryRun),
  };
  try {
    const result = await applyMergeProposal(PROJECT_DIR, {
      umbrellaName: typeof proposal.umbrellaName === 'string' ? proposal.umbrellaName : 'umbrella',
      heading: typeof proposal.heading === 'string' ? proposal.heading : '',
      mergeSkills: proposal.mergeSkills.map((item: unknown) => String(item)),
      rationale: typeof proposal.rationale === 'string' ? proposal.rationale : undefined,
      proposedDescription: typeof proposal.proposedDescription === 'string' ? proposal.proposedDescription : undefined,
    }, opts);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Clear the proposals file (Dismiss all).
app.delete('/api/curator/proposals', async (_req, res) => {
  try {
    await clearCuratorProposals(PROJECT_DIR);
    res.json({ ok: true });
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

function configureAutomationScheduler(): void {
  if (automationScheduler) {
    automationScheduler.stop();
    automationScheduler = null;
  }
  if (!automationSchedulerSettings.enabled) return;
  automationScheduler = new AutomationScheduler({
    projectDir: PROJECT_DIR,
    getPolicyContext: () => getAutomationPolicyContext(),
    isKillSwitchActive: () => killSwitchActive,
    isEnabled: () => automationSchedulerSettings.enabled && !killSwitchActive,
    getLastUserActivityMs: () => lastUserActivityMs,
    idleThresholdMinutes: automationSchedulerSettings.idleThresholdMinutes,
    onBreachDetected: (breaches) => {
      const msg = `⚠️ ${breaches.length} promise breach(es):\n${breaches.map((b) => `• ${b.breach_type}: ${b.detail.slice(0, 100)}`).join('\n')}`;
      sendTelegramNotification('Promise breach', msg).catch(() => {});
      sendWebhookNotification('promise.breach', { breaches }).catch(() => {});
    },
  });
  automationScheduler.start();
}

export function stopAutomationScheduler(): void {
  if (automationScheduler) {
    automationScheduler.stop();
    automationScheduler = null;
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

// --- API: Directory Browser (for the Agent Files folder picker) ---
// Lists subdirectories of any path on disk so the user can navigate to
// the destination folder for agent file_write outputs without typing.
// NOT confined to PROJECT_DIR — the whole point is the user picking a
// folder OUTSIDE the project (e.g. C:/AI/Lottery-Toolkit/inbox).
//
// Returns: { cwd, parent, presets, dirs[] }. presets are platform-aware
// quick-jump locations (home, Desktop, Documents, Downloads, project,
// project/agent-outputs). dirs is the immediate subdirectory listing.
app.get('/api/browse-dirs', async (req, res) => {
  try {
    const queryPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const home = os.homedir();
    const cwd = queryPath
      ? path.resolve(queryPath)
      : home;
    let parent: string | null = path.dirname(cwd);
    if (parent === cwd) parent = null;
    const presets: Array<{ label: string; path: string }> = [
      { label: 'Home', path: home },
      { label: 'Desktop', path: path.join(home, 'Desktop') },
      { label: 'Documents', path: path.join(home, 'Documents') },
      { label: 'Downloads', path: path.join(home, 'Downloads') },
      { label: 'Project root', path: PROJECT_DIR },
      { label: 'agent-outputs (default)', path: path.join(PROJECT_DIR, 'agent-outputs') },
    ];
    let dirs: Array<{ name: string; path: string }> = [];
    try {
      const entries = await fs.readdir(cwd, { withFileTypes: true });
      dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(cwd, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      // If the path is unreadable (permission denied, doesn't exist), still
      // return the presets so the UI stays useful.
      const msg = error instanceof Error ? error.message : String(error);
      res.json({ cwd, parent, presets, dirs: [], error: msg });
      return;
    }
    res.json({ cwd, parent, presets, dirs });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
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

function inferModelCapabilities(name: string, details: Record<string, unknown> = {}): { text: boolean; image: boolean; audio: boolean; toolUse: 'strong' | 'weak' | 'unknown'; notes: string[] } {
  const haystack = `${name} ${Object.values(details).join(' ')}`.toLowerCase();
  const image = isVisionCapableModelName(name, details);
  const audio = /whisper|audio|speech|wav2vec|parakeet|sensevoice/.test(haystack);

  // Tool-use capability heuristic based on model family and size.
  // Small chat-focused models often ignore tool schemas and answer from
  // training data instead of calling web_search/file_read etc.
  const weakToolModels = /gemma.*e[24]b|gemma.*2b|gemma.*4b|phi-?3.*mini|tinyllama|smollm|qwen2?\.?5?-?(0\.5|1\.5|3)b/i;
  const strongToolModels = /kimi|qwen.*coder.*(14|32|72)b|deepseek.*(v3|coder)|mistral.*(medium|large)|command-r|gpt-?4|claude|llama.*70b/i;
  const toolUse: 'strong' | 'weak' | 'unknown' = weakToolModels.test(name) ? 'weak'
    : strongToolModels.test(name) ? 'strong'
    : 'unknown';

  const notes = [
    image ? 'Can likely reason over images when the chat path passes image data.' : 'Text chat model unless another modality is documented by the model.',
    audio ? 'Audio-related model detected; transcription or audio tooling may be needed before chat.' : '',
    toolUse === 'weak' ? 'This model may not reliably call tools (web_search, file_read, etc.). For research or file tasks, consider a larger model.' : '',
  ].filter(Boolean);
  return { text: true, image, audio, toolUse, notes };
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
    agentPersonality,
    agentName,
    agentAvatar,
    agentProfiles,
    summarizerModel,
    contextMaxTokens,
    timeBudgetMs,
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
    automationScheduler: automationSchedulerSettings,
    disabledTools: Array.from(disabledTools).sort(),
    timedToolEnables: Object.fromEntries(Array.from(timedToolEnables.entries()).filter(([, exp]) => Date.now() < exp).map(([name, exp]) => [name, new Date(exp).toISOString()])),
    autonomyExpiresAt: autonomyExpiresAt > Date.now() ? new Date(autonomyExpiresAt).toISOString() : '',
    autonomyPreviousMode,
    killSwitch: { active: killSwitchActive, reason: killSwitchReason },
    capabilityGrants,
    allowedExternalPaths: getAllowedExternalPaths(),
    agentOutputDir,
    telegramBotToken,
    telegramAllowedChatIds,
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
  await loadStoredApiKeys();
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw) as Partial<WebSettings>;
    applyStoredSettings(settings);
  } catch {
    // Missing or malformed settings should not prevent the local UI from starting.
  }
}

/**
 * Load API keys from `.harness/api-keys.json` into `process.env` so the
 * remote-backend factory can pick them up. Lets users configure keys
 * via the UI without touching system env vars.
 *
 * Format: { "MISTRAL_API_KEY": "...", "GROQ_API_KEY": "...", ... }
 *
 * Environment variables that are ALREADY set (e.g. exported in the
 * shell) take precedence — the file only fills in the blanks. This
 * preserves the principle of least surprise for users who have keys
 * exported globally.
 */
async function loadStoredApiKeys(): Promise<void> {
  try {
    const raw = await fs.readFile(API_KEYS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      if (!ALLOWED_API_KEY_NAMES.has(key)) continue;
      if (process.env[key] && process.env[key]!.trim().length > 0) continue;
      process.env[key] = value.trim();
      // Remember that this env var was populated from the file, so the
      // GET /api/api-keys handler can report source='file' rather than
      // 'env' (which was misleading — the user never set it in the shell).
      FILE_SOURCED_KEYS.add(key);
    }
  } catch {
    // Missing file is fine — user simply hasn't entered any keys yet.
  }
}

/**
 * Tracks env vars that were populated from `.harness/api-keys.json`
 * by loadStoredApiKeys(). Consulted by the GET /api/api-keys handler
 * so users see 'stored' (file) instead of 'from env' for keys they
 * entered through the UI. Also updated by POST /api/api-keys when a
 * file-stored key is freshly written into process.env.
 */
const FILE_SOURCED_KEYS = new Set<string>();

const ALLOWED_API_KEY_NAMES = new Set([
  'OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'DEEPINFRA_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_MODELS_TOKEN',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'REPLICATE_API_TOKEN',
  'SAMBANOVA_API_KEY',
  'TOGETHER_API_KEY',
  'ANTHROPIC_API_KEY',
  'HARNESS_SMTP_HOST',
  'HARNESS_SMTP_PORT',
  'HARNESS_SMTP_USER',
  'HARNESS_SMTP_PASS',
  'HARNESS_SMTP_FROM',
  'HARNESS_SLACK_WEBHOOK_URL',
]);

function applyStoredSettings(settings: Partial<WebSettings>): void {
  if (settings.model !== undefined) currentModel = sanitizeModelName(settings.model);
  if (settings.permissionMode !== undefined && ALLOWED_PERMISSION_MODES.includes(settings.permissionMode)) permissionMode = settings.permissionMode;
  if (settings.ollamaHost !== undefined) {
    const parsedHost = parseHttpUrl(settings.ollamaHost);
    if (parsedHost) { ollamaHost = parsedHost; setRagRuntime({ ollamaHost }); }
  }
  if (settings.systemPrompt !== undefined) systemPromptOverride = String(settings.systemPrompt).slice(0, 20_000);
  if (settings.agentPersonality !== undefined) agentPersonality = String(settings.agentPersonality).slice(0, 5_000);
  if (settings.agentName !== undefined) agentName = String(settings.agentName).slice(0, 100);
  if (settings.agentAvatar !== undefined) agentAvatar = String(settings.agentAvatar).slice(0, 10);
  if (settings.agentProfiles !== undefined && typeof settings.agentProfiles === 'object') agentProfiles = sanitizeAgentProfiles(settings.agentProfiles);
  if (Array.isArray(settings.allowedExternalPaths)) {
    setAllowedExternalPaths(settings.allowedExternalPaths.map((p: unknown) => String(p).slice(0, 500)));
  }
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
  if (settings.automationScheduler !== undefined) {
    automationSchedulerSettings = sanitizeAutomationSchedulerSettings(settings.automationScheduler);
  }
  configureAutomationScheduler();
  if (Array.isArray(settings.disabledTools)) {
    const registry = createBuiltinToolRegistry();
    disabledTools.clear();
    for (const name of settings.disabledTools) {
      const value = String(name).trim();
      if (value && registry.get(value)) disabledTools.add(value);
    }
  }
  if (settings.timedToolEnables !== undefined && typeof settings.timedToolEnables === 'object' && settings.timedToolEnables !== null) {
    timedToolEnables.clear();
    const now = Date.now();
    for (const [name, iso] of Object.entries(settings.timedToolEnables as Record<string, unknown>)) {
      const ts = new Date(String(iso)).getTime();
      if (Number.isFinite(ts) && ts > now && disabledTools.has(name)) timedToolEnables.set(name, ts);
    }
  }
  if (typeof settings.autonomyExpiresAt === 'string' && settings.autonomyExpiresAt) {
    const ts = new Date(settings.autonomyExpiresAt).getTime();
    const prevMode = typeof settings.autonomyPreviousMode === 'string' && ALLOWED_PERMISSION_MODES.includes(settings.autonomyPreviousMode as PermissionMode)
      ? settings.autonomyPreviousMode as PermissionMode : 'default';
    if (Number.isFinite(ts) && ts > Date.now()) {
      autonomyExpiresAt = ts;
      autonomyPreviousMode = prevMode;
    } else {
      autonomyExpiresAt = 0;
    }
  }
  if (settings.killSwitch !== undefined && typeof settings.killSwitch === 'object' && settings.killSwitch !== null) {
    const ks = settings.killSwitch as { active?: unknown; reason?: unknown };
    killSwitchActive = Boolean(ks.active);
    killSwitchReason = killSwitchActive
      ? (typeof ks.reason === 'string' && ks.reason.trim() ? String(ks.reason).slice(0, 500) : 'Kill switch restored from saved state.')
      : '';
  }
  if (settings.capabilityGrants !== undefined) capabilityGrants = sanitizeCapabilityGrants(settings.capabilityGrants);
  if (settings.contextMaxTokens !== undefined) contextMaxTokens = clampNumber(settings.contextMaxTokens, 1024, 200_000, DEFAULT_CONTEXT_MAX_TOKENS);
  if (settings.timeBudgetMs !== undefined) timeBudgetMs = clampNumber(settings.timeBudgetMs, 0, 1_800_000, 0);
  if (settings.temperature !== undefined) temperature = clampNumber(settings.temperature, 0, 2, 0.7);
  if (settings.topP !== undefined) topP = clampNumber(settings.topP, 0, 1, 0.9);
  if (settings.agentOutputDir !== undefined) {
    agentOutputDir = String(settings.agentOutputDir).trim().slice(0, 500);
    if (agentOutputDir) process.env.HARNESS_AGENT_OUTPUT_DIR = agentOutputDir;
  }
  // Always re-sync after the allowed-path list and agentOutputDir have
  // both been loaded so the auto-include works regardless of order.
  syncAgentOutputDirIntoAllowedPaths();

  // Start/stop Telegram bot when token changes.
  if (settings.telegramBotToken !== undefined) {
    telegramBotToken = String(settings.telegramBotToken).trim().slice(0, 200);
  }
  if (settings.telegramAllowedChatIds !== undefined) {
    telegramAllowedChatIds = String(settings.telegramAllowedChatIds).trim().slice(0, 500);
  }
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
  return { enabled: source.enabled === true, profile, autoSelect: source.autoSelect !== false, skipOnLowSignal: source.skipOnLowSignal !== false };
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

function parseMcpInstallCommand(install: string): { command: string; args: string[] } {
  const parts = splitShellLikeArgs(install).map((part) => part === '${PWD}' ? '.' : part);
  const command = parts[0]?.trim();
  if (!command) throw new Error('MCP catalog entry is missing an install command.');
  return { command, args: parts.slice(1) };
}

function splitShellLikeArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote === 'single') {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function buildRuntimeSkillFile(input: {
  name: string;
  description: string;
  domain: string;
  triggers: string[];
  whenToUse: string;
  requiredTools: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  body: string;
}): string {
  const lines = [
    '---',
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
    `domain: ${yamlScalar(input.domain)}`,
    ...yamlList('triggers', input.triggers),
  ];
  if (input.whenToUse) lines.push(`when_to_use: ${yamlScalar(input.whenToUse)}`);
  if (input.requiredTools.length > 0) lines.push(...yamlList('required_tools', input.requiredTools));
  if (input.riskLevel) lines.push(`risk_level: ${yamlScalar(input.riskLevel)}`);
  lines.push('---', '', input.body);
  return `${lines.join('\n').trimEnd()}\n`;
}

function yamlList(key: string, values: string[]): string[] {
  if (values.length === 0) return [`${key}: []`];
  return [`${key}:`, ...values.map((value) => `  - ${yamlScalar(value)}`)];
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

function sanitizeSkillText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).replace(/[\r\n]+/g, ' ').slice(0, maxLength);
}

function sanitizeSkillBody(value: unknown): string {
  const body = typeof value === 'string' && value.trim()
    ? value.trim()
    : '# Instructions\n\nDescribe when to use this skill, the steps to follow, and how to validate the result.';
  return body.slice(0, 20_000);
}

function sanitizeSkillList(value: unknown, maxItems: number, maxLength: number): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of source) {
    const text = String(item ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, maxLength);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function sanitizeSkillRiskLevel(value: unknown): 'low' | 'medium' | 'high' | undefined {
  const risk = String(value ?? '').trim().toLowerCase();
  return risk === 'low' || risk === 'medium' || risk === 'high' ? risk : undefined;
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

function sanitizeAutomationSchedulerSettings(value: unknown): AutomationSchedulerSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : true,
    idleThresholdMinutes: clampInt(source.idleThresholdMinutes, 1, 60, 2),
  };
}

function sanitizeAgentProfiles(value: unknown): Record<string, { name: string; avatar: string; personality: string; model: string }> {
  if (typeof value !== 'object' || value === null) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, { name: string; avatar: string; personality: string; model: string }> = {};
  for (const [key, val] of Object.entries(source)) {
    if (typeof val !== 'object' || val === null) continue;
    const entry = val as Record<string, unknown>;
    result[key.slice(0, 100)] = {
      name: String(entry.name ?? '').slice(0, 100),
      avatar: String(entry.avatar ?? '').slice(0, 10),
      personality: String(entry.personality ?? '').slice(0, 5000),
      model: String(entry.model ?? '').slice(0, 200),
    };
  }
  return result;
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

/**
 * Ensure the user-chosen agentOutputDir is treated as an allowed external
 * path so file_write/file_read/list_files accept absolute paths into it.
 * Without this, an agent calling file_write directly into a folder OUTSIDE
 * the project (e.g. C:/Users/Brad/Documents/Oracle) gets confined-to-project
 * rejected. Idempotent — only adds when the dir is non-empty AND not already
 * in the allowed list. Preserves any user-managed entries.
 */
function syncAgentOutputDirIntoAllowedPaths(): void {
  if (!agentOutputDir) return;
  const resolved = path.resolve(agentOutputDir);
  const existing = getAllowedExternalPaths();
  for (const p of existing) {
    if (path.resolve(p) === resolved) return;
  }
  setAllowedExternalPaths([...existing, resolved]);
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

let _saveSettingsLock: Promise<void> = Promise.resolve();
async function saveSettingsToDisk(): Promise<void> {
  // Serialize saves to prevent concurrent write races
  _saveSettingsLock = _saveSettingsLock.then(_doSaveSettings, _doSaveSettings);
  return _saveSettingsLock;
}
async function _doSaveSettings(): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const { outputValidationProfiles, customOutputValidationProfiles: profiles, ...settings } = getCurrentSettings();
  void outputValidationProfiles;
  void profiles;
  // Merge with any fields that exist in the file but are not tracked in-memory
  // (e.g. fields added by newer code not yet loaded). This prevents a running
  // server from clobbering file edits made to fields it does not manage.
  let merged: Record<string, unknown> = settings;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const existing = JSON.parse(raw) as Record<string, unknown>;
    merged = { ...existing, ...settings };
  } catch { /* file missing or invalid — use settings as-is */ }
  const json = JSON.stringify(merged, null, 2);
  // Validate before writing — never write invalid JSON
  try { JSON.parse(json); } catch { logger.warn('Settings', 'Skipped save: serialized JSON is invalid'); return; }
  // Atomic write: write to temp file then rename
  const tmpPath = SETTINGS_PATH + '.tmp';
  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, SETTINGS_PATH);
}

async function getRuntimeStorageSummary(): Promise<{ traces: { count: number; bytes: number }; semanticIndex: { exists: boolean; bytes: number } }> {
  return {
    traces: await directoryJsonStats(TRACES_DIR),
    semanticIndex: await fileStats(path.join(PROJECT_DIR, '.harness', 'memory', 'semantic-index.json')),
  };
}

async function getAboutInfo(): Promise<{ version: string; commit: string; assetName: string; assetSha256: string; releaseUrl: string; generatedAt: string; manifestName: string; manifestUrl: string }> {
  const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_DIR, 'package.json'), 'utf-8')) as { version?: string };
  const rawProvenance = await readReleaseProvenance();
  const provenance = packageJson.version && rawProvenance.version && rawProvenance.version !== packageJson.version ? {} : rawProvenance;
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

async function checkSourceDistFreshness(): Promise<void> {
  const sourceKey = path.join(PROJECT_DIR, 'src', 'web', 'server.ts');
  const distKey = path.join(PROJECT_DIR, 'dist', 'web', 'server.js');
  try {
    const [srcStat, distStat] = await Promise.all([fs.stat(sourceKey), fs.stat(distKey)]);
    if (srcStat.mtimeMs > distStat.mtimeMs + 1000) {
      console.log(`\n  ⚠️  Source files are newer than compiled output.`);
      console.log(`      Run "npm run build" to pick up recent changes.`);
    }
  } catch { /* dist or source missing — skip check */ }
}

export async function startServer(): Promise<void> {
  await ensureSettingsLoaded();
  await checkSourceDistFreshness();
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

    // Start Telegram bot if token is configured.
    const tgToken = telegramBotToken || process.env.HARNESS_TELEGRAM_BOT_TOKEN;
    if (tgToken) {
      loadPersistedChatIds(PROJECT_DIR).then(() => {
        const bot = startTelegramBot(tgToken, url, telegramAllowedChatIds ? telegramAllowedChatIds.split(',') : undefined);
        if (bot) console.log(`  Telegram bot:          connected`);
      }).catch(() => {});
    }

    // Start Discord bot if token is configured.
    const dcToken = discordBotToken || process.env.HARNESS_DISCORD_BOT_TOKEN;
    if (dcToken) {
      const bot = startDiscordBot(dcToken, url, discordAllowedChannelIds ? discordAllowedChannelIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
      if (bot) console.log(`  Discord bot:           connecting...`);
    }

    console.log(`\n  Press Ctrl+C to stop.\n`);

    // Load webhooks from env.
    loadWebhooksFromEnv();

    // Auto-build code intelligence graph (non-blocking).
    loadRepoGraph(PROJECT_DIR).then((existing) => {
      if (!existing) {
        buildRepoGraph(PROJECT_DIR, { maxFiles: 5_000, ignoreDirs: ['hermes-agent-main', 'agent-outputs', 'journal', 'Bracknell_Food_Business'] }).then((graph) => {
          saveRepoGraph(PROJECT_DIR, graph).then(async () => {
            const summary = summarizeRepo(graph);
            console.log(`  Code intelligence:     ${summary.total_files} files, ${summary.total_edges} edges`);
            // Seed mycelium with code intelligence.
            try {
              const { loadMyceliumGraph, saveMyceliumGraph } = await import('../mycelium/graph');
              const myGraph = await loadMyceliumGraph(PROJECT_DIR);
              if (myGraph) {
                const importEdges = graph.edges
                  .filter((e) => e.type === 'imports')
                  .map((e) => ({ from: e.from, to: e.to }));
                const seeded = seedCodeIntelligence(myGraph, {
                  mostImported: summary.most_imported.slice(0, 20),
                  edges: importEdges.slice(0, 50),
                });
                if (seeded.nodesAdded > 0 || seeded.edgesAdded > 0) {
                  await saveMyceliumGraph(PROJECT_DIR, myGraph);
                  console.log(`  Code → Mycelium:       ${seeded.nodesAdded} nodes, ${seeded.edgesAdded} edges seeded`);
                }
              }
            } catch { /* mycelium seeding is optional */ }
          });
        }).catch(() => {});
      }
    }).catch(() => {});

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
