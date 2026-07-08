import express from 'express';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { watch as fsWatch, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import * as net from 'net';
import * as crypto from 'crypto';
import * as os from 'os';
import { once } from 'events';
import { Ollama } from 'ollama';
import { OllamaClient, drainOllamaChatRetryEvents } from '../core/ollamaClient';
import { createChatClient, OPENAI_COMPATIBLE_PRESETS, REPLICATE_PRESET, readApiKey } from '../core/chatClientFactory';
import { drainRemoteProviderFallbackEvents } from '../core/fallbackChatClient';
import type { IChatClient } from '../core/chatClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { createCodeVerifier, createLlmPlanner, createQueryLoopExecutor, runConductor, type ConductorEvent } from '../core/taskConductor';
import { createLlmAdversaryJudge } from '../safety/toolInspectors';
import { buildMorningBriefing, type BriefingCalendarEvent } from '../jarvis/morningBriefing';
import { parseIcsEvents } from '../tools/calendarTools';
import { getRuntimeTools } from '../tools';
import { createToolRegistry } from '../tools/registry';
import { WorkflowRegistry } from '../workflows/workflowRegistry';
import { runCurator, runDeterministicPhase, readCuratorLog, readCuratorProposals, type CuratorConfig } from '../curator/curator';
import { CuratorScheduler } from '../curator/scheduler';
import { SelfLearningHeartbeat, createCleanupAgentOutputsAction, createIdentityGcAction, createReflectAndLearnAction, createSkillEvolutionAction, createWorkAssignedTasksAction, defaultHeartbeatActions, readHeartbeatHistory } from '../services/selfLearningHeartbeat';
import { TriggerScheduler } from '../services/triggerScheduler';
import { SchedulerRegistry } from '../services/schedulerRegistry';
import { TeammateScheduler, sanitizeTeammateSettings, defaultTeammateSettings, type TeammateSettings, type TeammateChannel } from '../automation/teammateScheduler';
import { listActiveSubagents, subscribeSubagentRegistry } from '../services/subagentRegistry';
import { createToolFailureAlerts, type ToolFailureAlertTracker } from '../services/toolFailureAlerts';
import { formatPrometheusMetrics, type PrometheusMetric } from '../observability/prometheus';
import { getSwallowedFailureDroppedCount, getSwallowedFailureTotalCount, recordSwallowed } from '../observability/silentFailureSink';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { summarizeTasks } from '../services/taskStore';
import { createTaskRoutesRouter, type CodexTaskRunner, type CodexTaskRunnerEvent } from './taskRoutes';
import { createPromiseRouter } from './promiseRoutes';
import { createProfileRouter } from './profileRoutes';
import { createEvalRouter } from './evalRoutes';
import { createMemoryHealthRouter } from './memoryHealthRoutes';
import { createScanRouter } from './scanRoutes';
import { createPromptsRouter } from './promptsRoutes';
import { createEventRouter } from './eventRoutes';
import { createDoneStateRouter } from './doneStateRoutes';
import { createCodeIntelRouter } from './codeIntelRoutes';
import { createMyceliumRouter } from './myceliumRoutes';
import { createTraceRouter } from './traceRoutes';
import { createSnapshotRouter } from './snapshotRoutes';
import { createHistoryRouter } from './historyRoutes';
import { createFileRedirectRouter } from './fileRedirectRoutes';
import { createDocumentRouter } from './documentRoutes';
import { createBenchmarkRouter } from './benchmarkRoutes';
import { createSquadRouter } from './squadRoutes';
import { createRuntimeCostRouter } from './runtimeCostRoutes';
import { createTriggerRouter } from './triggerRoutes';
import { createArtifactRouter } from './artifactRoutes';
import { createSubagentRouter } from './subagentRoutes';
import { createSessionRouter } from './sessionRoutes';
import { createMemoryRouter } from './memoryRoutes';
import { createRagRouter } from './ragRoutes';
import { createServiceRouter } from './serviceRoutes';
import { createSkillRouter } from './skillRoutes';
import { createWorkflowRouter } from './workflowRoutes';
import { createWebhookRouter } from './webhookRoutes';
import { createWorkingMemoryRouter } from './workingMemoryRoutes';
import { createReviewQueueRouter } from './reviewQueueRoutes';
import { createBrowserHardeningRouter } from './browserHardeningRoutes';
import { createAgentRouter } from './agentRoutes';
import { createFileBrowseRouter } from './fileBrowseRoutes';
import { createAssetRouter } from './assetRoutes';
import { createNervousRouter } from './nervousRoutes';
import { createSynthesisStatsRouter } from './synthesisStatsRoutes';
import { createAboutRouter } from './aboutRoutes';
import { createAtlasRouter } from './atlasRoutes';
import { createBudgetRouter } from './budgetRoutes';
import { createConnectorRouter } from './connectorRoutes';
import { createSaveOutputRouter } from './saveOutputRoutes';
import { createMiscRouter } from './miscRoutes';
import { createRunsRouter } from './runsRoutes';
import { createLearningRouter } from './learningRoutes';
import { createMcpRouter } from './mcpRoutes';
import { createUploadsRouter } from './uploadsRoutes';
import { createTeammateRouter } from './teammateRoutes';
import { createToolsRouter } from './toolsRoutes';
import { createCuratorRouter } from './curatorRoutes';
import { createEvalsRouter } from './evalsRoutes';
import { createAutomationRouter } from './automationRoutes';
import { recordSkillUse, recordSkillView } from '../extensibility/skillUsage';
import { applyFileWriteRedirect, drainUploadsFallbacks, getAllowedExternalPaths, getUploadsDir, maybeRedirectAgentOutput, resolveProjectReadPath, setAllowedExternalPaths, setProjectRoot } from '../tools/pathResolution';
import { iteratePdfPages, MAX_PDF_BYTES } from '../tools/pdfTool';
import { setSkillsDir, setLowerSkillTiers } from '../tools/skillTools';
import { setImportSkillsDir } from '../tools/skillImportTool';
import { setInstallSkillsDir } from '../tools/skillInstallTool';
import { setRagRuntime } from '../tools/ragTools';
import { setCuratorToolRuntime } from '../tools/curatorTools';
import { PermissionEngine } from '../permissions/engine';
import { PermissionPromptBroker } from '../permissions/promptBroker';
import { KillSwitch } from '../permissions/killSwitch';
import { SandboxSwitch } from '../permissions/sandboxSwitch';
import { setSandboxStateProvider } from '../tools/sandboxGuards';
import { createCapabilityGrant, evaluateCapabilityGrant, findExpiredGrants, listActiveCapabilityGrants, listCapabilityPolicies, mapToolsToCapabilityCoverage, revokeCapabilityGrant, sanitizeCapabilityGrants, summarizeCapabilityAlignment, autoGrantGatedCapabilities, type CapabilityGrant } from '../permissions/capabilities';
import { SessionStorage } from '../persistence/sessionStorage';
import { rebuildSemanticMemory, searchSemanticMemory } from '../persistence/semanticMemory';
import * as snapshots from '../persistence/snapshots';
import * as ragIndex from '../persistence/ragIndex';

import { assembleSystemContext, estimateTokenCount } from '../context/assembly';
import { HookPipeline } from '../extensibility/hookPipeline';
import { createAuditHooks, readAuditLog, renderRecentAuditForPrompt } from '../permissions/audit';
import { loadSkillsDir, loadSkillsFromDirs, matchSkillTrigger, scanSkillsDir, type SkillDefinition, type SkillDirectoryScan } from '../extensibility/skillLoader';
import { discoverExtensionManifests } from '../extensibility/extensionManifest';
import { RateLimiter } from '../core/rateLimiter';
import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { attachOtlpExporter, type OtlpExporter } from '../observability/otlpExporter';
import { mintTraceId } from '../observability/openinference';
import { summarizeRunCost, type RunUsageSample, type ModelLocality } from '../observability/costProvenance';
import { assessAnswerConfidence } from '../observability/answerConfidence';
import { buildRunProvenance } from '../observability/runProvenance';
import { assessOfflineGuarantee } from '../observability/offlineGuarantee';
import { OUTPUT_VALIDATION_PROFILES, OUTPUT_VALIDATION_PROFILE_TEMPLATES, describeOutputValidationProfileSuggestion, normalizeCustomOutputValidationProfiles, parseOutputValidationProfile, validateCustomOutputValidationProfiles, validateOutput, type CustomOutputValidationProfile, type OutputValidationProfile } from '../core/outputValidation';
import { loadSynthesisStats, recordSynthesisFired, recordSessionCompleted, adaptiveMaxTurns, adaptiveTimeBudget, recordAvgTurnDuration, recordToolUseStats } from '../core/synthesisStats';
import { loadModelReliability, recordModelOutcome, modelReliabilityScore } from '../core/modelReliability';
import { appendRewardEntry } from '../core/rewardLedger';
import { startNewSession, onSessionEnd, getEvolvedPrompt, recordSessionAutoContinue, LearningRecorder } from '../learning/engine';
import { getApprovedAutonomyPrompt } from '../learning/autonomyPrompt';
import { listEvalTraceRuns, recordContextLossEvalRun, recordOutputValidationEvalRun, recordProfileFeedbackEvalRun, recordUploadsFallbackEvalRun } from '../learning/evalTrace';
import { appendLearningCandidate, extractLearningCandidate, listLearningCandidates, listReviewedLearningCandidates } from '../learning/sessionLearning';
import { createSubagentTool } from '../agents/subagent';
import { applyGrantToLadder, clearRuntimeRegistry, composeDailyBrief, composeMermaidGraph, defaultAmbientActionPolicy, ensureCapability, eventsFromAmbientSignals, eventsFromEvidenceCards, getInboundTriageStatus, getKnowledgeGraphStatus, getMcpServerStatus, getRuntimeRegistryStatus, getVoiceStatus, ingestEvidenceCard, loadRuntimeRegistry, loadTrustLadder, markRuntimeInstalled, mergeAndSort, mineNextActions, readAll as readKnowledgeGraph, recall as kgRecall, recordOutcome, recordPermissionOutcome, runCouncilForChat, saveRuntimeRegistry, saveTrustLadder, snapshotDailyBrief, startAmbientDaemon, upsertEntity, type AmbientDaemonHandle, type RuntimeFeature } from '../jarvis';
import { SignalBus } from '../nervous/signals';
import { BUILTIN_AGENT_ROLES, loadAgentDefinitions } from '../agents/agentLoader';
import { classifyIntent, logConciergeDecision, readConciergeLog } from '../services/concierge';
import { getModelProfile, loadModelProfiles, setModelProfileField, type ModelProfileStore } from '../services/modelProfiles';
import { getSquad, listSquads, routeMessage } from '../services/squad';
import { resolveSessionSquad } from '../services/squadSessions';
import { renderIdentityForPrompt } from '../services/identity';
import { createIdentityRouter } from './identityRoutes';
import { IdentityAutoUpdateScheduler } from '../services/identityAutoUpdateScheduler';
import { checkSetupHealth } from '../setup/health';
import { probeToolCalling, type ToolCallProbeResult } from '../setup/toolCallProbe';
import { getModelCatalog, getModelCatalogCacheStatus } from '../models/modelCatalog';
import { isVisionCapableModelName, isVisionModelUsable } from '../models/visionModels';
import { createAutomationJob, listAutomationJobs, listDueAutomationJobs, readAutomationRunLog } from '../automation/jobs';
import { AutomationScheduler } from '../automation/scheduler';
import { handleOperateModeRequest, listAgenticServices } from '../services/agenticServiceMode';
import { classifyMode, type HarnessMode } from '../services/modeClassifier';
import { createDefaultCapabilityRegistry, type CapabilityRegistry } from '../services/capabilityRegistry';
import { evaluateCapabilityTemplates, type ConnectorReadinessInput } from '../services/capabilityTemplates';
import { getCapabilityTemplateStarter, listCapabilityTemplateStarters, type CapabilityTemplateStarter } from '../services/capabilityTemplateStarters';
import { createPromise, listPromises, updatePromise, checkObligations, fulfilPromise, failPromise, detectCommitments, type PromiseStatus } from '../services/promiseLedger';
import { emitEvent, queryEvents, summarizeEventStore } from '../persistence/eventStore';
import { attachWsServer } from './wsServer';
import { tryDeterministicShortcut } from '../core/deterministicShortcuts';
import { tryGoalSlashCommand } from '../services/goalSlashCommand';
import { createGoalRouter } from './goalRoutes';
import { makeShellCommandRunner, type IterationRunner } from '../goal/shellRunner';
import { makeQueryLoopRunner } from '../goal/queryLoopRunner';
import { surfaceResumableGoalOnBoot } from '../goal/bootResume';
import { parseJestSummary } from '../goal/verification';
import { parsePrioritySetCommand, setPriorityForToday } from '../services/morningPriority';
import { routeSlashCommand, registerYoloHooks, registerResearchHooks } from '../services/slashCommandRouter';
import { calculateReadiness, type ReadinessInput } from '../core/readinessGate';
import { planBuildGate, runBuildGate, buildGateVerifierScore, type BuildGateResult, type GateCommand, type ProjectProbe } from '../core/buildGate';
import { buildTaskContract } from '../core/taskContractBuilder';
import { BUILTIN_PROFILES, applyProfile, filterToolsByProfile } from '../services/configProfiles';
import { renderDriftReport } from '../eval/goldenTraces';
import { setCcmemToken, setCcmemUrl } from '../services/conceptMemoryClient';
import { validateStructuredOutput, parseAndValidate, detectSchema, BUILTIN_SCHEMAS } from '../core/structuredOutputValidator';
import { buildRepoGraph, summarizeRepo, saveRepoGraph, loadRepoGraph } from '../core/codeIntelligence';
import { createMycelialRouter, deriveToolShortlist, toolNamesFromRoute, type MycelialContextRouter } from '../mycelium/router';
import { heuristicVerifier } from '../mycelium/verifier';
import { seedCodeIntelligence } from '../mycelium/seeds';
import { getSessionSearchIndexStatus, rebuildSessionSearchIndexWithMetadata } from '../persistence/sessionSearchIndex';
import { appendRunEvidence, inspectRunEvidence, readRunEvidence, setEvidenceAppendHook, type StoredRunEvidence } from '../persistence/evidenceStore';
import { startTelegramBot, stopTelegramBot, isTelegramBotRunning, sendTelegramNotification, loadPersistedChatIds, getTelegramPollingLockInfo } from '../integrations/telegram';
import { startDiscordBot, stopDiscordBot, isDiscordBotRunning } from '../integrations/discord';
import { getSlackConnectorStatus, sanitizeSlackWebhookUrl } from '../integrations/slack';
import { getWhatsAppConnectorStatus, sanitizeWhatsAppSetup } from '../integrations/whatsapp';
import { configureWebReadTool, DEFAULT_WEB_READ_MAX_CHARS, sanitizeWebReadMaxChars } from '../tools/webSearchTool';
import { initWebhookStore, loadWebhooksFromEnv, sendWebhookNotification } from '../integrations/webhooks';
import { initReviewQueue, enqueueFromGoverned } from '../governed/reviewQueue';
import { initReplayConsumer, type ReplayCandidate } from '../governed/replayConsumer';
import { runReplayCandidates } from '../governed/replayRunner';
import { initReplayLedger, appendReplayLedgerEntry } from '../governed/replayLedger';
import type { GovernedAnswer } from '../governed/governedAnswer';
import * as nodemailer from 'nodemailer';
import { NervousSystemController } from '../nervous';
import { listShellCommandAllowlistPresets } from '../automation/runner';
import { appendCapabilityAuditEvent, readCapabilityAuditEvents } from '../permissions/capabilityAudit';
import { selectModelForChatTurn, type ChatModelCandidatePool, type ChatRoutingMode, type ModelRoutingPolicy } from '../agents/modelRouting';
import type { LoopConfig, LoopEvent, PermissionMode, Tool } from '../types';
import type { EvidenceCard, EvidenceFileSummary, EvidenceMode, EvidenceToolSummary } from '../types/evidence';
import type { Message } from 'ollama';

const MODULE_LOAD_STARTED_AT = Date.now();

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
    // Clickjacking protection. The dashboard's CSP <meta> tag cannot set
    // frame-ancestors (browsers ignore it there); these headers do the job.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  },
}));

/**
 * Workspace isolation: the agent must NEVER write into the harness source tree.
 * If no HARNESS_PROJECT_DIR is set and the harness is launched from its own
 * source repo, we redirect to ~/apex-workspace (created on first run). We detect
 * the repo by the presence of src/web/server.ts and src/tools/dispatcher.ts.
 * Set HARNESS_PROJECT_DIR to pin a stable home (recommended) so the data dir
 * never drifts between launches.
 */
function resolveProjectDir(): string {
  if (process.env.HARNESS_PROJECT_DIR) {
    return path.resolve(process.env.HARNESS_PROJECT_DIR);
  }
  // Detect if cwd is the harness source repo
  const cwd = process.cwd();
  const isHarnessRepo =
    existsSync(path.join(cwd, 'src', 'web', 'server.ts')) &&
    existsSync(path.join(cwd, 'src', 'tools', 'dispatcher.ts'));
  // Tests write fixtures into cwd/.harness; don't redirect under jest.
  // (jest sets NODE_ENV='test' automatically; --runInBand does not set JEST_WORKER_ID.)
  if (isHarnessRepo && (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID)) {
    return cwd;
  }
  if (isHarnessRepo) {
    const safeDefault = path.join(os.homedir(), 'apex-workspace');
    if (!existsSync(safeDefault)) {
      mkdirSync(safeDefault, { recursive: true });
    }
    console.log(`⚠️  Workspace isolation: cwd is the harness repo — redirecting to ${safeDefault}`);
    console.log(`   Set HARNESS_PROJECT_DIR to override (e.g. your app folder).`);
    return safeDefault;
  }
  return cwd;
}

const PROJECT_DIR = resolveProjectDir();
setProjectRoot(PROJECT_DIR);
// Surface the resolved project dir at startup. A silently-moved home is what
// makes the harness appear to "lose" its memory/identity, so make it visible.
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  const projectDirSource = process.env.HARNESS_PROJECT_DIR ? 'HARNESS_PROJECT_DIR' : 'auto-detected';
  console.log(`📁 Harness project dir: ${PROJECT_DIR} (source: ${projectDirSource})`);
}
// LOCAL_HOST controls the bind interface. Defaults to loopback (127.0.0.1) so
// the dashboard is reachable only from this machine. If you set HOST to a
// non-loopback address (e.g. 0.0.0.0) to share the UI on your network, you
// MUST also set HARNESS_API_AUTH_TOKEN — API auth flips on automatically in
// that case, and requests without the token are rejected. The UI is otherwise
// unauthenticated and can drive shell/file tools, so never expose it without
// the token.
const LOCAL_HOST = process.env.HOST ?? '127.0.0.1';
const API_AUTH_TOKEN = (process.env.HARNESS_API_AUTH_TOKEN ?? '').trim();
const HISTORY_DIR = path.join(PROJECT_DIR, '.harness', 'chat-history');
const SKILLS_DIR = path.join(PROJECT_DIR, '.harness', 'skills');
const REPO_SKILLS_DIR = path.join(PROJECT_DIR, '.github', 'skills');
// Global, user-level skills shared across every workspace. Allow an override
// for tests/headless setups via HARNESS_GLOBAL_SKILLS_DIR.
const GLOBAL_SKILLS_DIR = (process.env.HARNESS_GLOBAL_SKILLS_DIR ?? '').trim()
  || path.join(os.homedir(), '.harness', 'skills');
const TRACES_DIR = path.join(PROJECT_DIR, '.harness', 'traces');
const DOCUMENTS_DIR = path.join(PROJECT_DIR, '.harness', 'documents');
const SETTINGS_PATH = path.join(PROJECT_DIR, '.harness', 'settings.json');
const SETTINGS_SAVE_RETRY_DELAYS_MS = [25, 75, 150, 300, 600];
const API_KEYS_PATH = path.join(PROJECT_DIR, '.harness', 'api-keys.json');
const OUTPUT_VALIDATION_PROFILES_PATH = path.join(PROJECT_DIR, '.harness', 'output-validation-profiles.json');
// Harness install root — the directory containing the harness's own
// package.json and release artifacts. Distinct from PROJECT_DIR, which can be
// redirected to an isolated user workspace; src/web/server.ts and
// dist/web/server.js both sit two levels below the harness root.
const HARNESS_ROOT = path.resolve(__dirname, '..', '..');
export function resolveJarvisWhisperBridgePath(): string {
  return path.join(HARNESS_ROOT, 'scripts', 'jarvis_whisper.py');
}

export function resolveHarnessSourceDistFreshnessPaths(): { sourceKey: string; distKey: string } {
  return {
    sourceKey: path.join(HARNESS_ROOT, 'src', 'web', 'server.ts'),
    distKey: path.join(HARNESS_ROOT, 'dist', 'web', 'server.js'),
  };
}

// ─── Chat build gate ──────────────────────────────────────────────────────
// Advisory test-and-learn validation: after a chat turn writes source files,
// detect the project type and run a cheap validation (Node typecheck/test,
// Python py_compile + import smoke) so the readiness gate and the learning
// signal reflect whether the code the agent wrote actually works. Never
// blocks the response; any failure is reported and fed back, not thrown.
const execFileAsync = promisify(execFile);
const GATE_COMMAND_TIMEOUT_MS = 60_000;

/** True when `dir` is the harness's own source tree (we must never build it). */
function isInsideHarnessRoot(dir: string): boolean {
  const rel = path.relative(HARNESS_ROOT, path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Gather the filesystem facts the pure planner needs (best-effort, never throws). */
function probeProjectForGate(workingDir: string, changedPyFiles: string[]): ProjectProbe {
  let hasPackageJson = false;
  let packageScripts: Record<string, string> = {};
  try {
    const pkgPath = path.join(workingDir, 'package.json');
    if (existsSync(pkgPath)) {
      hasPackageJson = true;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
      if (pkg.scripts && typeof pkg.scripts === 'object') packageScripts = pkg.scripts;
    }
  } catch { /* unreadable package.json — treat as none */ }

  // Importable top-level python packages: a changed .py file's nearest ancestor
  // chain of `__init__.py` dirs whose top dir sits directly under workingDir.
  const pythonPackages = new Set<string>();
  for (const file of changedPyFiles) {
    try {
      let dir = path.dirname(path.resolve(workingDir, file));
      let topPackage: string | undefined;
      while (dir.startsWith(path.resolve(workingDir)) && existsSync(path.join(dir, '__init__.py'))) {
        topPackage = path.basename(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      // Only keep it when the top package's parent is the working dir, so
      // `python -c "import <name>"` resolves from cwd=workingDir.
      if (topPackage && path.resolve(dir) === path.resolve(workingDir)) {
        pythonPackages.add(topPackage);
      }
    } catch { /* skip unresolvable path */ }
  }

  // Detect pytest-discoverable tests so a Python project is validated against
  // its own tests, symmetric with running a Node project's `test` script.
  let pythonHasTests = false;
  try {
    if (changedPyFiles.length > 0) {
      if (existsSync(path.join(workingDir, 'tests'))) {
        pythonHasTests = true;
      } else {
        pythonHasTests = readdirSync(workingDir).some((name) => /^test_.*\.py$/.test(name) || /.*_test\.py$/.test(name));
      }
    }
  } catch { /* unreadable working dir — assume no tests */ }

  return { hasPackageJson, packageScripts, pythonPackages: [...pythonPackages], pythonHasTests };
}

/**
 * Run the advisory build gate for a chat turn. Returns a non-run result for any
 * skip condition (harness repo, test env, no source files changed, no validation
 * detected) and never throws — a gate failure is data, not an exception.
 */
async function runChatBuildGate(workingDir: string, changedFiles: string[]): Promise<BuildGateResult> {
  const notRun = (reason: string): BuildGateResult => ({ ran: false, passed: true, kind: 'none', results: [], score: undefined, summary: reason });
  try {
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return notRun('skipped under test');
    if (process.env.HARNESS_DISABLE_BUILD_GATE === '1') return notRun('disabled via HARNESS_DISABLE_BUILD_GATE');
    if (isInsideHarnessRoot(workingDir)) return notRun('skipped: harness source tree');

    const sourceFiles = changedFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i.test(f));
    if (sourceFiles.length === 0) return notRun('no source files changed');

    const pyFiles = sourceFiles.filter((f) => /\.py$/i.test(f));
    const probe = probeProjectForGate(workingDir, pyFiles);
    const plan = planBuildGate({ changedFiles: sourceFiles, workingDir, probe });

    return await runBuildGate(plan, async (cmd: GateCommand) => {
      const bin = cmd.command === 'npm' && process.platform === 'win32' ? 'npm.cmd' : cmd.command;
      try {
        const { stdout, stderr } = await execFileAsync(bin, cmd.args, { cwd: cmd.cwd, timeout: GATE_COMMAND_TIMEOUT_MS, windowsHide: true });
        return { exitCode: 0, output: `${stdout}\n${stderr}`.trim().slice(0, 2000) };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
        const exitCode = typeof e.code === 'number' ? e.code : 1;
        return { exitCode, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.trim().slice(0, 2000) };
      }
    });
  } catch (err) {
    logger.warn('BuildGate', 'Gate execution failed (advisory, ignored)', { error: err instanceof Error ? err.message : String(err) });
    return notRun('gate error');
  }
}

const WORKFLOWS_DIR = path.join(PROJECT_DIR, '.harness', 'workflows');
const workflowRegistry = new WorkflowRegistry(WORKFLOWS_DIR);
const ALLOWED_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'dontAsk'];
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
let autonomyChild: ChildProcessWithoutNullStreams | null = null;
let autonomyStartedAt: string | undefined;
// Snapshot of the most recently completed chat's nervous-system state.
// Filled in at chat-handler exit so /api/nervous reflects the last finished
// run. Per-chat controllers are created locally inside the chat handler so
// concurrent chats no longer scribble onto a shared instance.
let lastNervousSnapshot: {
  summary: ReturnType<NervousSystemController['getSummary']>;
  signals: ReturnType<NervousSystemController['getSignals']>;
  recovery: ReturnType<NervousSystemController['getRecoveryPlan']>;
  runState: ReturnType<NervousSystemController['getRunState']>;
} | null = null;

function parseOptionalBoolean(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

const API_AUTH_REQUIRED_OVERRIDE = parseOptionalBoolean(process.env.HARNESS_API_AUTH_REQUIRED);

const API_AUTH_REQUIRED = (() => {
  if (API_AUTH_REQUIRED_OVERRIDE !== null) return API_AUTH_REQUIRED_OVERRIDE;
  // If a token is configured, default to requiring auth even on loopback.
  // Operators can still force-disable this with HARNESS_API_AUTH_REQUIRED=0.
  if (API_AUTH_TOKEN) return true;
  // Require API auth by default when serving on non-loopback interfaces.
  return !isLoopbackHost(LOCAL_HOST);
})();

const API_AUTH_INSECURE_OVERRIDE = Boolean(API_AUTH_TOKEN) && API_AUTH_REQUIRED_OVERRIDE === false;

const API_AUTH_BYPASS_PATHS = new Set<string>([
  '/api/auth/config',
]);

function hasValidApiAuth(request: express.Request): boolean {
  if (!API_AUTH_TOKEN) return false;
  const authHeader = request.headers.authorization;
  const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  const altHeader = typeof request.headers['x-harness-api-token'] === 'string'
    ? request.headers['x-harness-api-token'].trim()
    : '';
  return bearerToken === API_AUTH_TOKEN || altHeader === API_AUTH_TOKEN;
}

function requireEscalationAuth(req: express.Request, res: express.Response, actionLabel: string): boolean {
  if (!API_AUTH_TOKEN) return true;
  if (hasValidApiAuth(req)) return true;
  res.setHeader('WWW-Authenticate', 'Bearer realm="HarnessApiToken"');
  res.status(401).json({ error: `Unauthorized ${actionLabel}. Provide a valid API token.` });
  return false;
}

function parseAuditReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}

function requireAuditReason(
  value: unknown,
  res: express.Response,
  actionLabel: string,
): string | null {
  const reason = parseAuditReason(value);
  if (reason.length >= 8) return reason;
  res.status(400).json({ error: `${actionLabel} requires a reason of at least 8 characters.` });
  return null;
}

// ── Active Goal routes ───────────────────────────────────────────────────
// Mounted early so the goals API is available regardless of which other
// route blocks follow. The router is self-contained; it only needs
// projectDir + auth + a runner factory. The factory below dispatches on the
// request body so callers pick the runner explicitly per /start request.
app.use(createGoalRouter({
  projectDir: PROJECT_DIR,
  requireAuth: (req, res, label) => requireEscalationAuth(req, res, label),
  makeRunner: async (body: unknown, _goalId: string): Promise<IterationRunner> => {
    const b = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
    const kind = typeof b.runner === 'string' ? b.runner : 'shell';
    if (kind === 'shell') {
      if (typeof b.command !== 'string' || b.command.trim().length === 0) {
        throw new Error("'shell' runner requires 'command' (string)");
      }
      return makeShellCommandRunner({
        command: b.command,
        args: Array.isArray(b.args) ? b.args.filter((a): a is string => typeof a === 'string') : undefined,
        cwd: typeof b.cwd === 'string' ? b.cwd : PROJECT_DIR,
        timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined,
      });
    }
    if (kind === 'queryloop') {
      // Drive the harness chat loop as the iteration body — same model,
      // same tools the chat UI uses. Picks up the server's currently
      // selected model unless the request body overrides it.
      const model = typeof b.model === 'string' && b.model.trim().length > 0 ? b.model : currentModel;
      if (!model) throw new Error("'queryloop' runner requires a selected model (no current model set)");
      const baseSystemPrompt = typeof b.systemPrompt === 'string' && b.systemPrompt.length > 0
        ? b.systemPrompt
        : (systemPromptOverride || 'You are an autonomy agent. Make concrete progress on the active goal each iteration. The outer loop will run verification after you stop.');
      // Phase 2: optionally apply the Phase-3-gated evolved prompt to unattended
      // runs. Default OFF (env unset) => systemPrompt is byte-identical to
      // baseSystemPrompt, so the default autonomy path is unchanged.
      const gated = await getApprovedAutonomyPrompt({
        projectDir: PROJECT_DIR,
        basePrompt: baseSystemPrompt,
        applyEvolvedPrompt: process.env.HARNESS_APPLY_EVOLVED_PROMPT_AUTONOMY === '1',
      });
      const systemPrompt = gated.prompt;
      const client = webRuntime.createClient(model, ollamaHost);
      const tools = webRuntime.getTools();
      return makeQueryLoopRunner({
        client,
        tools,
        model,
        systemPrompt,
        projectDir: PROJECT_DIR,
        maxTurnsPerIteration: typeof b.maxTurns === 'number' ? b.maxTurns : undefined,
        maxTimeMs: typeof b.maxTimeMs === 'number' ? b.maxTimeMs : undefined,
      });
    }
    throw new Error(`unsupported runner kind: '${kind}' (supported: 'shell', 'queryloop')`);
  },
}));

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
  webReadMaxChars: number;
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
  /** Teammate mode: scheduled Daily Brief generation + delivery. */
  teammate: import('../automation/teammateScheduler').TeammateSettings;
  modelDebugLog: ModelDebugLogSettings;
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
  /** Last known sandbox state. Restored on startup so containment persists across restarts. */
  sandbox: { active: boolean; reason: string };
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
  discordBotToken: string;
  discordAllowedChannelIds: string;
  slackWebhookUrl: string;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappAllowedRecipients: string;
  /** URL of the Concept Cells memory service (ccmem). Empty = disabled.
   *  Default: http://localhost:8765 (override via HARNESS_CCMEM_URL). */
  ccmemUrl: string;
  /** Browser audit/trace redaction policy. When `redactValues` is on,
   *  `browser_fill` values are masked in the audit log; `urlMode: 'origin'`
   *  drops URL paths/query-strings (which can carry tokens) from the log. */
  browserRedaction: { redactValues: boolean; urlMode: 'full' | 'origin' };
}

interface ConnectorSecretStatus {
  configured: boolean;
  source: 'env' | 'file' | 'none';
}

interface PublicWebSettings extends WebSettings {
  connectorSecretStatus: {
    discordBotToken: ConnectorSecretStatus;
    slackWebhookUrl: ConnectorSecretStatus;
    whatsappAccessToken: ConnectorSecretStatus;
  };
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

interface ModelDebugLogSettings {
  enabled: boolean;
  path: string;
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
  listModels(host: string): Promise<string[]>;
  getTools(): Tool[];
  createPermissionEngine(mode: PermissionMode): PermissionEngine;
  createSession(projectDir: string, model: string): SessionStorage;
  startNewSession(): void;
  getEvolvedPrompt(basePrompt: string): Promise<string>;
  assembleSystemContext(input: { systemPrompt: string; projectDir: string; skillsDir: string; recallProjectDir?: string; recallQuery?: string; ragProjectDir?: string; ragQuery?: string; ragOllamaHost?: string; palaceProjectDir?: string; sessionSearchProjectDir?: string; sessionSearchQuery?: string; ccmemUrl?: string; ccmemQuery?: string; ccmemTopK?: number }): Promise<string>;
  runQueryLoop: QueryLoopRunner;
  onSessionEnd(): Promise<{ reflection: { insights: string[] }; newPatterns: unknown[] }>;
  rebuildSemanticMemory(projectDir: string): Promise<unknown[]>;
}

// Resolve the default Ollama host, honoring the OLLAMA_HOST env var when set.
// OLLAMA_HOST is a server *bind* directive (e.g. "0.0.0.0:11434"); bind-all
// addresses are not valid client targets, so map them back to localhost.
function resolveDefaultOllamaHost(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return 'http://localhost:11434';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = '11434';
    if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '') {
      url.hostname = 'localhost';
    }
    return url.origin;
  } catch {
    return 'http://localhost:11434';
  }
}

// --- State ---
let currentModel = '';
let permissionMode: PermissionMode = 'default';
let ollamaHost = resolveDefaultOllamaHost();
let systemPromptOverride = '';
let agentPersonality = '';
let agentName = '';
let agentAvatar = '';
let agentProfiles: Record<string, { name: string; avatar: string; personality: string; model: string }> = {};

/**
 * Build the "Your name is X. <personality>" preamble injected ahead of the
 * base system prompt. Shared between the main chat path and delegated
 * sub-agents so a configured persona carries through to delegations.
 * Returns '' when neither field is set.
 */
function buildAgentIdentityPrefix(): string {
  return [
    agentName ? `Your name is ${agentName}.` : '',
    agentPersonality || '',
  ].filter(Boolean).join(' ');
}
let summarizerModel = '';
const DEFAULT_CONTEXT_MAX_TOKENS = 8192;
const MYCELIUM_CONTEXT_MAX_CHARS = 4_000;
let contextMaxTokens = DEFAULT_CONTEXT_MAX_TOKENS;
let detectedContextMaxTokens: number | null = null;
let webReadMaxChars = DEFAULT_WEB_READ_MAX_CHARS;
let timeBudgetMs = 0; // 0 = auto-detect (180s local, 600s cloud)
let temperature = 0.7;
let topP = 0.9;
let modelRouting: ModelRoutingPolicy = {};
// Per-session one-shot model escalations queued by the readiness gate. Keyed
// by client-supplied sessionId. Consumed (and cleared) on the next turn when
// modelRouting.autoEscalateOnLowReadiness is enabled.
const pendingReadinessEscalations = new Map<string, string>();
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
let slackWebhookUrl: string = process.env.HARNESS_SLACK_WEBHOOK_URL ?? '';
let whatsappAccessToken: string = process.env.HARNESS_WHATSAPP_ACCESS_TOKEN ?? '';
let whatsappPhoneNumberId: string = process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID ?? '';
let whatsappAllowedRecipients: string = process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS ?? '';
let ccmemUrl: string = process.env.HARNESS_CCMEM_URL?.trim() || 'http://localhost:8765';
let browserRedaction: { redactValues: boolean; urlMode: 'full' | 'origin' } = { redactValues: true, urlMode: 'full' };

/** Coerce arbitrary input into a valid browserRedaction policy (secure defaults). */
function sanitizeBrowserRedaction(value: unknown): { redactValues: boolean; urlMode: 'full' | 'origin' } {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    redactValues: v.redactValues !== false,
    urlMode: v.urlMode === 'origin' ? 'origin' : 'full',
  };
}
let outputValidation: OutputValidationSettings = { enabled: false, profile: 'oracle-prime', autoSelect: true, skipOnLowSignal: true };
let customOutputValidationProfiles: CustomOutputValidationProfile[] = [];
let modelCatalog: ModelCatalogSettings = { url: '', ttlHours: 24 };
let extensionActivation: ExtensionActivationSettings = { executablePlugins: false, allowedPluginNames: [], requirePermissionReview: true };
let walkthrough: WalkthroughSettings = { completed: [] };
let settingsLoaded = false;
/**
 * Shared kill-switch state. Holds the single source of truth for engaged /
 * released and the operator reason. The server keeps the module-level
 * `killSwitchActive` / `killSwitchReason` mirrors below in lockstep with
 * this instance via `applyKillSwitchState()` so the dozens of existing
 * read sites do not need to change. Mutations MUST go through
 * `applyKillSwitchState()` so the mirror cannot drift.
 *
 * Per-session `PermissionEngine` instances are created with this same
 * instance attached (see `defaultWebRuntime.createPermissionEngine`) so
 * they always see live state instead of a construction-time snapshot.
 */
const killSwitch = new KillSwitch();
/**
 * Shared sandbox-mode state. Soft containment that narrows the blast
 * radius of every tool call (path confinement, shell allowlist, network
 * denylist) without disabling the agent outright. Lives at the module
 * level so per-session PermissionEngine instances and subagents both
 * observe the SAME switch — sandbox is process-wide by design, so a
 * subagent cannot exit sandbox the parent is in.
 *
 * Tools consult this via `setSandboxStateProvider` (wired below) so the
 * dependency edge stays one-way (tools → permissions has no import).
 */
const sandboxSwitch = new SandboxSwitch();
setSandboxStateProvider(() => sandboxSwitch.isActive());
/** Process-wide scheduler lifecycle registry (curator, heartbeat, etc.). */
const schedulerRegistry = new SchedulerRegistry();
let killSwitchActive = false;
let killSwitchReason = '';

/**
 * Apply a kill-switch state change through the shared `KillSwitch` and keep
 * the module-level mirrors in sync. This is the only function that should
 * mutate `killSwitchActive` / `killSwitchReason`.
 */
function applyKillSwitchState(active: boolean, reason: string = ''): void {
  if (active) {
    killSwitch.engage(reason || 'Kill switch engaged.');
  } else {
    killSwitch.release();
  }
  const snap = killSwitch.snapshot();
  killSwitchActive = snap.active;
  killSwitchReason = snap.reason;
}

/**
 * Restore the kill switch from a persisted snapshot (settings load only).
 * Does not fire listeners — startup restoration is not a state transition.
 */
function restoreKillSwitchState(snapshot: { active?: unknown; reason?: unknown } | null | undefined): void {
  killSwitch.restore({
    active: Boolean(snapshot?.active),
    reason: typeof snapshot?.reason === 'string' ? snapshot.reason : '',
  });
  const snap = killSwitch.snapshot();
  killSwitchActive = snap.active;
  killSwitchReason = snap.reason;
}
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
let teammateSettings: TeammateSettings = sanitizeTeammateSettings({});
let teammateScheduler: TeammateScheduler | null = null;
let modelDebugLog: ModelDebugLogSettings = sanitizeModelDebugLogSettings({
  enabled: Boolean(process.env.HARNESS_DEBUG_LOG?.trim()),
  path: process.env.HARNESS_DEBUG_LOG || '.harness/model-debug.jsonl',
});
applyModelDebugLogEnvironment(modelDebugLog);
let lastUserActivityMs = Date.now();
let curatorScheduler: CuratorScheduler | null = null;
// Identity auto-update scheduler. Always-on once configured: per-tick
// behaviour is governed by .harness/identity/auto-update.json (default
// both targets off), so wiring it in never causes identity to change
// on its own. Kill switch and idle-gate still apply.
let identityAutoUpdateScheduler: IdentityAutoUpdateScheduler | null = null;
// Self-learning heartbeat. Disabled unless HARNESS_HEARTBEAT_ENABLED=1 so
// existing installs keep the same behavior. Survives restarts via in-memory
// timestamp; the scheduler internally gates on interval + kill switch.
let selfLearningHeartbeat: SelfLearningHeartbeat | null = null;
let heartbeatLastRunMs = 0;
// Trigger scheduler. Disabled unless HARNESS_TRIGGERS_ENABLED=1.
let triggerScheduler: TriggerScheduler | null = null;let automationScheduler: AutomationScheduler | null = null;

// System-health feature toggles. Each value is one of:
//   undefined  → fall back to env (legacy behaviour, default for fresh installs)
//   true/false → explicit override from settings.json (Settings UI)
// The env var is still authoritative when set explicitly to truthy/falsy
// values; only "unset" yields to the settings override.
interface SystemFeatureFlags {
  heartbeatEnabled?: boolean;
  triggersEnabled?: boolean;
  conciergeEnabled?: boolean;
  conciergeAutoRoute?: boolean;
  squadAutoRoute?: boolean;
  otelExportEnabled?: boolean;
}
let systemFeatureFlags: SystemFeatureFlags = {};

function readEnvFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return undefined;
}

function resolveFeatureFlag(envName: string, settingKey: keyof SystemFeatureFlags): boolean {
  const fromEnv = readEnvFlag(envName);
  if (fromEnv !== undefined) return fromEnv;
  return systemFeatureFlags[settingKey] === true;
}

/**
 * The "assistant" runtime profile. When HARNESS_PROFILE=assistant (or
 * HARNESS_ASSISTANT is truthy), the personal-assistant features that used to
 * require a separate launcher (start-jarvis.bat) default ON, so a single
 * entry point runs the unified product. Explicit env vars still win, because
 * each caller checks its own env flag before consulting the profile.
 *
 * HARNESS_PROFILE=assistant-proactive is a superset: it also enables the
 * proactive-autonomy subsystems (see proactiveProfileEnabled). It still
 * satisfies the base assistant profile so voice/ambient/channels stay on.
 */
export function assistantProfileEnabled(): boolean {
  const profile = (process.env.HARNESS_PROFILE ?? '').trim().toLowerCase();
  if (profile === 'assistant' || profile === 'assistant-proactive') return true;
  return readEnvFlag('HARNESS_ASSISTANT') === true;
}

/**
 * The "assistant-proactive" runtime profile. This is an explicit, deliberate
 * opt-in for standing autonomy: the self-learning heartbeat (timer-driven,
 * model-backed) and the trigger scheduler (autonomous event reactions) default
 * ON. It is intentionally NOT implied by the plain `assistant` profile, because
 * those subsystems spend compute on a timer and act without prompting — that
 * should never start as a side effect of launching the app. Concierge
 * auto-route stays opt-in regardless (silent chat rerouting is its own choice).
 */
export function proactiveProfileEnabled(): boolean {
  const profile = (process.env.HARNESS_PROFILE ?? '').trim().toLowerCase();
  return profile === 'assistant-proactive';
}

/**
 * Whether the Jarvis ambient daemon should start on boot. An explicit
 * HARNESS_AMBIENT_ENABLED value always wins; otherwise the assistant profile
 * enables it. This preserves the old start-jarvis.bat behaviour (which set
 * HARNESS_AMBIENT_ENABLED=1 directly) under the unified launcher.
 */
export function ambientEnabled(): boolean {
  const fromEnv = readEnvFlag('HARNESS_AMBIENT_ENABLED');
  if (fromEnv !== undefined) return fromEnv;
  return assistantProfileEnabled();
}

/** Check whether a tool is effectively enabled right now, considering timed enables. */
function isToolEnabled(name: string): boolean {
  if (!disabledTools.has(name)) return true;
  const expiry = timedToolEnables.get(name);
  if (expiry !== undefined) {
    if (Date.now() < expiry) return true;
    // Expired — clean up
    timedToolEnables.delete(name);
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
  }
  // Capability-grant gate: an active grant for `arbitrary-shell` enables the
  // docker_exec sandbox tool atomically. Granting the capability is the
  // single act that flips both the policy posture and the usable tool.
  if (name === 'docker_exec' && hasActiveCapability('arbitrary-shell')) return true;
  return false;
}

function hasActiveCapability(capabilityId: string, now = new Date()): boolean {
  const active = listActiveCapabilityGrants(capabilityGrants, now);
  return active.some((grant) => grant.capabilityId === capabilityId);
}

/** Check and revert timed autonomy if expired. */
function checkAutonomyExpiry(): void {
  if (autonomyExpiresAt > 0 && Date.now() >= autonomyExpiresAt) {
    const prev = autonomyPreviousMode;
    logger.info('Permissions', 'Timed autonomy expired, reverting to ' + prev);
    appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.expired', reason: `Expired, reverted to ${prev}` }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
    permissionMode = prev;
    autonomyExpiresAt = 0;
    autonomyPreviousMode = 'default';
    revokeAutoGrantedCapabilities('Auto-revoked: timed autonomy expired.');
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
  }
}

/**
 * Revoke any capability grants that were issued automatically while dontAsk
 * mode was active. Called when timed autonomy ends (expiry, manual clear, or
 * kill switch) so /yolo cannot leave behind 8-hour grants that outlive it.
 * The match tag is the `reason` string written by autoGrantGatedCapabilities.
 */
function revokeAutoGrantedCapabilities(revocationReason: string): number {
  const AUTO_TAG = 'Auto-granted in dontAsk mode.';
  const autoGranted = capabilityGrants.filter((g) => g.reason === AUTO_TAG);
  if (autoGranted.length === 0) return 0;
  capabilityGrants = sanitizeCapabilityGrants(
    capabilityGrants.filter((g) => g.reason !== AUTO_TAG),
  );
  for (const grant of autoGranted) {
    appendCapabilityAuditEvent(PROJECT_DIR, {
      type: 'grant.revoked',
      capabilityId: grant.capabilityId,
      grantId: grant.id,
      reason: revocationReason,
    }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
  }
  logger.info('Permissions', `Revoked ${autoGranted.length} auto-granted capability grant(s): ${revocationReason}`);
  return autoGranted.length;
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

// ─── Custom agents cache ────────────────────────────────────────────
// Re-read .harness/agents/ at most once every 30s. Cheap, but avoids
// scanning the directory on every chat call.
let cachedCustomAgents: import('../agents/agentLoader').AgentDefinition[] = [];
let cachedCustomAgentsAt = 0;
const CUSTOM_AGENTS_TTL_MS = 30_000;

async function refreshCustomAgentsIfStale(now = Date.now()): Promise<void> {
  if (now - cachedCustomAgentsAt < CUSTOM_AGENTS_TTL_MS) return;
  try {
    cachedCustomAgents = await loadAgentDefinitions(PROJECT_DIR);
    cachedCustomAgentsAt = now;
  } catch {
    // Best-effort — keep the previous cache.
  }
}

function getCachedCustomAgentsSnapshot(): import('../agents/agentLoader').AgentDefinition[] {
  return cachedCustomAgents.slice();
}

/**
 * Build the chat tool list: registry tools (after disables) plus a live
 * `agent` tool bound to the current parent client and tool snapshot. The
 * subagent tool sees the same enabled tool set as the parent loop, minus
 * itself (recursion guard happens inside filterToolsForSubagent).
 */
function buildChatTools(parentClient: import('../core/chatClient').IChatClient): Tool[] {
  const baseTools = applyToolDisables(getRuntimeTools(PROJECT_DIR));
  const subagentTool = createSubagentTool({
    getParentClient: () => parentClient,
    getAvailableTools: () => baseTools,
    getCustomAgents: getCachedCustomAgentsSnapshot,
    getIdentityPrefix: buildAgentIdentityPrefix,
    // Jarvis: share the project's knowledge graph with delegated subagents.
    async getRecallContext(prompt: string): Promise<string | undefined> {
      try {
        const result = await kgRecall(PROJECT_DIR, prompt.slice(0, 240), 3);
        const lines: string[] = [];
        for (const e of result.entities) lines.push(`- entity ${e.type}: ${e.name}`);
        for (const f of result.facts) lines.push(`- fact: ${f.subject} ${f.predicate} ${f.object}`);
        for (const ed of result.edges) lines.push(`- edge: ${ed.from} ${ed.relation} ${ed.to}`);
        if (lines.length === 0) return undefined;
        return `[Knowledge graph recall for this task]\n${lines.join('\n')}`;
      } catch {
        return undefined;
      }
    },
  });
  return [...baseTools.filter((tool) => tool.name !== 'agent'), subagentTool];
}

function conciergeEnabled(): boolean {
  return resolveFeatureFlag('HARNESS_CONCIERGE_ENABLED', 'conciergeEnabled');
}

function conciergeAutoRouteEnabled(): boolean {
  return resolveFeatureFlag('HARNESS_CONCIERGE_AUTO_ROUTE', 'conciergeAutoRoute');
}

/**
 * When the concierge is enabled, classify the user's message and return a
 * brief system note suggesting delegation. The note is intended to be
 * appended to the system prompt for that turn so the model can decide
 * whether to call the `agent` tool. Returns null when the message should
 * be answered directly.
 */
function buildConciergeNote(userMessage: string): string | null {
  if (!conciergeEnabled()) return null;
  if (typeof userMessage !== 'string' || !userMessage.trim()) return null;
  const allAgents = [...getCachedCustomAgentsSnapshot(), ...BUILTIN_AGENT_ROLES];
  const triage = classifyIntent(userMessage, allAgents);
  // Always log the decision (note path) so operators can see what the
  // concierge thinks even when nothing is delegated.
  logConciergeDecision(PROJECT_DIR, {
    messagePreview: userMessage,
    delegateTo: triage.delegateTo,
    reason: triage.reason,
    matchedKeyword: triage.matchedKeyword,
    confidence: triage.confidence,
    autoRouted: false,
  }).catch((err) => recordSwallowed('server.ts:605', err));
  if (!triage.delegateTo) return null;
  return `Concierge triage: this turn looks like a fit for the "${triage.delegateTo}" sub-agent (reason: ${triage.reason}, confidence: ${triage.confidence.toFixed(2)}). You may delegate by calling the \`agent\` tool with { agent_id: "${triage.delegateTo}", prompt: "<task>" }, or answer directly if you prefer.`;
}

/**
 * Auto-route mode. When HARNESS_CONCIERGE_AUTO_ROUTE is set, the concierge
 * runs the suggested sub-agent directly and returns the summary so the
 * server can short-circuit the normal model loop. Returns null if the
 * message should fall through to the normal flow.
 */
async function maybeConciergeAutoRoute(
  userMessage: string,
  parentClient: import('../core/chatClient').IChatClient,
): Promise<{ agentId: string; reason: string; summary: string } | null> {
  if (!conciergeEnabled() || !conciergeAutoRouteEnabled()) return null;
  if (typeof userMessage !== 'string' || !userMessage.trim()) return null;
  const allAgents = [...getCachedCustomAgentsSnapshot(), ...BUILTIN_AGENT_ROLES];
  const triage = classifyIntent(userMessage, allAgents);
  if (!triage.delegateTo) return null;
  const baseTools = applyToolDisables(getRuntimeTools(PROJECT_DIR));
  const { runSubagent } = await import('../agents/subagent');
  const summary = await runSubagent(
    {
      name: triage.delegateTo,
      systemPrompt: '',
      agentId: triage.delegateTo,
      customAgents: getCachedCustomAgentsSnapshot(),
    },
    userMessage,
    parentClient,
    baseTools.filter((tool) => tool.name !== 'agent'),
  );
  await emitEvent(PROJECT_DIR, 'system', 'concierge.auto_route', {
    agentId: triage.delegateTo,
    reason: triage.reason,
    confidence: triage.confidence,
    messagePreview: userMessage.slice(0, 200),
  }, 'concierge').catch((err) => recordSwallowed('server.ts:643', err));
  await logConciergeDecision(PROJECT_DIR, {
    messagePreview: userMessage,
    delegateTo: triage.delegateTo,
    reason: triage.reason,
    matchedKeyword: triage.matchedKeyword,
    confidence: triage.confidence,
    autoRouted: true,
  }).catch((err) => recordSwallowed('server.ts:651', err));
  return { agentId: triage.delegateTo, reason: triage.reason, summary };
}

function squadAutoRouteEnabled(): boolean {
  return resolveFeatureFlag('HARNESS_SQUAD_AUTO_ROUTE', 'squadAutoRoute');
}

/**
 * When the chat request specifies a squadId that resolves to a known squad,
 * use the squad's routing rules to suggest an agent and prepend a system
 * note. Returns null when no squad is associated with this turn.
 */
async function buildSquadRoutingNote(squadId: string | undefined, userMessage: string): Promise<string | null> {
  if (!squadId || !userMessage.trim()) return null;
  const squad = await getSquad(PROJECT_DIR, squadId).catch(() => undefined);
  if (!squad) return null;
  const route = routeMessage(squad, userMessage);
  return `Squad "${squad.id}" routed this turn to "${route.agentId}" (${route.reason}). Delegate via the \`agent\` tool with { agent_id: "${route.agentId}", prompt: "<task>" } when appropriate.`;
}

/**
 * Squad auto-route. When HARNESS_SQUAD_AUTO_ROUTE is set and the chat
 * request specifies a squadId, the routed agent runs directly via
 * runSubagent and the summary is streamed back. Returns null otherwise.
 */
async function maybeSquadAutoRoute(
  squadId: string | undefined,
  userMessage: string,
  parentClient: import('../core/chatClient').IChatClient,
): Promise<{ agentId: string; reason: string; summary: string; squadId: string } | null> {
  if (!squadAutoRouteEnabled()) return null;
  if (!squadId || !userMessage.trim()) return null;
  const squad = await getSquad(PROJECT_DIR, squadId).catch(() => undefined);
  if (!squad) return null;
  const route = routeMessage(squad, userMessage);
  const baseTools = applyToolDisables(getRuntimeTools(PROJECT_DIR)).filter((tool) => tool.name !== 'agent');
  const { runSubagent } = await import('../agents/subagent');
  const summary = await runSubagent(
    {
      name: route.agentId,
      systemPrompt: '',
      agentId: route.agentId,
      customAgents: getCachedCustomAgentsSnapshot(),
    },
    userMessage,
    parentClient,
    baseTools,
  );
  await emitEvent(PROJECT_DIR, 'system', 'squad.auto_route', {
    squadId: squad.id,
    agentId: route.agentId,
    reason: route.reason,
    messagePreview: userMessage.slice(0, 200),
  }, 'squad').catch((err) => recordSwallowed('server.ts:705', err));
  return { agentId: route.agentId, reason: route.reason, summary, squadId: squad.id };
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
// Audit-everything: write each tool call (pre + post + failure) to
// .harness/audit.log unless explicitly opted out via env. Hooks log only —
// they never block, so this is safe to enable by default.
if ((process.env.HARNESS_AUDIT_LOG ?? '').trim().toLowerCase() !== 'off') {
  for (const hook of createAuditHooks({ projectDir: PROJECT_DIR })) hookPipeline.register(hook);
}
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
  listModels: (host) => new OllamaClient({ model: '', host }).listModels(),
  getTools: () => {
    configureWebReadTool({ maxChars: webReadMaxChars });
    // The subagent tool needs a parent client to delegate to; create one
    // for the current model. The custom-agents cache is refreshed
    // opportunistically so on-disk changes apply within ~30s.
    refreshCustomAgentsIfStale().catch((err) => recordSwallowed('refreshCustomAgentsIfStale', err));
    const parentClient = webRuntime.createClient(currentModel || 'llama3.1:8b', ollamaHost);
    return buildChatTools(parentClient);
  },
  createPermissionEngine: (mode) => {
    // Pass the shared kill switch so per-session engines always see live
    // state instead of a construction-time snapshot (audit #6 / v0.5.6).
    const engine = new PermissionEngine([], mode, undefined, killSwitch);
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
const pendingChatBackgroundTasks = new Set<Promise<unknown>>();

function queueChatBackgroundTask(label: string, task: Promise<unknown>): void {
  const tracked = task.catch((err) => recordSwallowed(label, err));
  pendingChatBackgroundTasks.add(tracked);
  tracked.finally(() => pendingChatBackgroundTasks.delete(tracked));
}

export async function drainChatBackgroundTasksForTest(): Promise<void> {
  while (pendingChatBackgroundTasks.size > 0) {
    await Promise.allSettled(Array.from(pendingChatBackgroundTasks));
  }
}

// Enrich shell-command approval cards with a friendly, model-generated
// explanation and a safe "always allow" pattern. Wired here (not at broker
// construction) because it depends on `webRuntime`/`currentModel`, which are
// defined above only as this point. Advisory only — never gates a decision.
permissionPrompts.setClassifier({
  infer: async ({ systemPrompt, userMessage, timeoutMs }) => {
    const client = webRuntime.createClient(currentModel || 'llama3.1:8b', ollamaHost);
    const chat = client.chatOnce(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('classifier inference timed out')), timeoutMs ?? 8_000);
    });
    const result = await Promise.race([chat, timeout]);
    return result.message.content ?? '';
  },
});


type SkillApiSource = 'runtime' | 'repo' | 'global';

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
    enabled: skill.enabled !== false,
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
// Let the agent also invoke repo (.github/skills) and global (~/.harness/skills)
// skills. Ordered low-to-high precedence: global, then repo; the workspace tier
// set above outranks both, so a workspace skill shadows a same-named global one.
setLowerSkillTiers([GLOBAL_SKILLS_DIR, REPO_SKILLS_DIR]);
setImportSkillsDir(SKILLS_DIR);
setInstallSkillsDir(SKILLS_DIR);
setRagRuntime({ projectDir: PROJECT_DIR, ollamaHost });
setCuratorToolRuntime({
  projectDir: PROJECT_DIR,
  getConfig: () => curatorConfigFromSettings(),
  isKillSwitchActive: () => killSwitch.isActive(),
});

// --- API Routes ---

app.get('/api/auth/config', (_req, res) => {
  res.json({
    required: API_AUTH_REQUIRED,
    configured: Boolean(API_AUTH_TOKEN),
    insecureOverride: API_AUTH_INSECURE_OVERRIDE,
    header: 'Authorization: Bearer <token>',
    altHeader: 'x-harness-api-token: <token>',
  });
});

// DNS-rebinding defence: when bound to loopback, only accept Host headers
// pointing at a loopback name. A malicious page that tricks the browser into
// resolving evil.example to 127.0.0.1 still sends Host: evil.example, so
// rejecting non-loopback host names blocks the rebind even though the IP
// matches. Skipped when LOCAL_HOST is non-loopback because the operator has
// opted into external access (auth is the gate there).
const HOST_HEADER_ENFORCED = isLoopbackHost(LOCAL_HOST);
const HOST_HEADER_ALLOWED_NAMES = new Set<string>(['127.0.0.1', 'localhost', '::1', '[::1]']);
app.use('/api', (req, res, next) => {
  if (!HOST_HEADER_ENFORCED) {
    next();
    return;
  }
  const rawHost = req.headers.host;
  if (typeof rawHost !== 'string' || rawHost.length === 0) {
    res.status(421).json({ error: 'Missing Host header.' });
    return;
  }
  // Strip port; preserve IPv6 brackets.
  const hostname = rawHost.startsWith('[')
    ? rawHost.slice(0, rawHost.indexOf(']') + 1).toLowerCase()
    : rawHost.split(':')[0].toLowerCase();
  if (!HOST_HEADER_ALLOWED_NAMES.has(hostname)) {
    res.status(421).json({ error: 'Misdirected request: Host header not in allow-list.' });
    return;
  }
  next();
});

// ── Cross-origin / CSRF defense (defense-in-depth) ──────────────────────
// On loopback the API auth token is optional, so a malicious web page the
// user happens to visit could try to drive the local agent through the
// browser (classic CSRF). Auth here is a bearer token (not cookies) and we
// emit no CORS headers (cross-origin JSON reads are preflight-blocked), so
// the practical risk is already low — but state-changing requests get an
// explicit belt-and-braces check:
//   - reject when the browser flags the request as cross-site, and
//   - reject when an Origin header is present but its host is off-allowlist.
// Non-browser clients (CLI, Telegram bridge, the in-process autonomy loop)
// send no Origin / Sec-Fetch-Site headers and pass through untouched, so the
// loop / learn / continue-until-done paths are unaffected. Only enforced on
// loopback; non-loopback relies on the auth token as the gate.
const CSRF_GUARDED_METHODS = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use('/api', (req, res, next) => {
  if (!HOST_HEADER_ENFORCED || !CSRF_GUARDED_METHODS.has(req.method)) {
    next();
    return;
  }
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') {
    res.status(403).json({ error: 'Cross-site request rejected.' });
    return;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost: string;
    try {
      // new URL('http://[::1]:4300').hostname === '[::1]', which matches the
      // bracketed entry in HOST_HEADER_ALLOWED_NAMES.
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      res.status(403).json({ error: 'Malformed Origin header.' });
      return;
    }
    if (!HOST_HEADER_ALLOWED_NAMES.has(originHost)) {
      res.status(403).json({ error: 'Cross-origin request rejected: Origin not in allow-list.' });
      return;
    }
  }
  next();
});

app.use('/api', (req, res, next) => {
  const fullPath = `${req.baseUrl}${req.path}`;
  if (!API_AUTH_REQUIRED || API_AUTH_BYPASS_PATHS.has(fullPath)) {
    next();
    return;
  }
  if (!API_AUTH_TOKEN) {
    res.status(503).json({ error: 'API auth is required but HARNESS_API_AUTH_TOKEN is not configured.' });
    return;
  }
  if (!hasValidApiAuth(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="HarnessApiToken"');
    res.status(401).json({ error: 'Unauthorized API request. Provide a valid API token.' });
    return;
  }
  next();
});

// ─── About / release verification ──────────────────────────────────────
// Both /api/about and /api/about/verify and their five helpers
// (getAboutInfo, getReleaseVerification, sha256FileIfExists,
// readReleaseProvenance, readReleaseManifest) + RELEASE_PROVENANCE_PATH were
// HTTP-only — extracted to ./aboutRoutes.ts. Router only needs harnessRoot.
app.use(createAboutRouter({ harnessRoot: HARNESS_ROOT }));

// Project Atlas — read-only structural/historical map of the workspace
// (which task built which file, when it last changed, current plan status).
// Synthesizes IMPLEMENTATION_PLAN.md + .forge-history.jsonl; never writes.
app.use(createAtlasRouter({ projectDir: PROJECT_DIR }));

// Surface the autonomy loop's checkpoint so the UI can show a live progress
// banner. Returns 204 when no autonomy run has occurred (file absent), 200
// with the parsed checkpoint otherwise. Read-only; never blocks on disk.
app.get('/api/autonomy/state', async (_req, res) => {
  const statePath = path.join(PROJECT_DIR, '.forge-state.json');
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
let _sseConnectionCount = 0;
const MAX_SSE_CONNECTIONS = 10;
const SSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

app.get('/api/autonomy/state/stream', (req, res) => {
  if (_sseConnectionCount >= MAX_SSE_CONNECTIONS) {
    res.status(503).json({ error: 'Too many SSE connections' });
    return;
  }
  _sseConnectionCount++;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const statePath = path.join(PROJECT_DIR, '.forge-state.json');

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
    watcher = fsWatch(PROJECT_DIR, (_event, filename) => {
      if (!filename || filename.toString() !== '.forge-state.json') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void sendSnapshot(); }, 100);
    });
  } catch {
    // Best-effort; if watching the cwd fails fall back to keepalive only.
  }

  // Heartbeat every 25s to keep proxies / browsers from idling out.
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);
  const idleTimeout = setTimeout(() => res.destroy(), SSE_IDLE_TIMEOUT_MS);

  // Use res.on('close') (NOT req.on('close')) to detect client disconnect
  // on long-lived SSE responses — req-close fires too early on some
  // node versions.
  res.on('close', () => {
    _sseConnectionCount--;
    clearTimeout(idleTimeout);
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
  });
});

// Tail the autonomy loop log (.forge-run.log). `?lines=N` selects how many
// trailing lines to return (default 50, max 500). Returns 204 when no log
// exists yet so the UI can hide the panel without surfacing an error.
app.get('/api/autonomy/log', async (req, res) => {
  const logPath = path.join(PROJECT_DIR, '.forge-run.log');
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
  const historyPath = path.join(PROJECT_DIR, '.forge-history.jsonl');
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

function sanitizeSpawnEnv(baseEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!key || key.includes('\u0000')) continue;
    if (platform === 'win32' && (key.startsWith('=') || key.includes('='))) continue;
    if (typeof value !== 'string' || value.includes('\u0000')) continue;
    safeEnv[key] = value;
  }
  return safeEnv;
}

function buildMinimalWindowsSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {};
  const coreKeys = [
    'PATH', 'Path',
    'PATHEXT',
    'SystemRoot', 'SYSTEMROOT',
    'WINDIR',
    'ComSpec', 'COMSPEC',
    'TEMP', 'TMP',
    'USERPROFILE', 'HOME',
  ];
  for (const key of coreKeys) {
    const value = env[key];
    if (typeof value === 'string' && value && !value.includes('\u0000')) minimal[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/^HARNESS_|^FORGE_/.test(key)) continue;
    if (typeof value !== 'string' || !value || value.includes('\u0000')) continue;
    minimal[key] = value;
  }
  return minimal;
}

async function readAutonomyPlanPreview(planPath = path.join(PROJECT_DIR, 'IMPLEMENTATION_PLAN.md')): Promise<{ tasks: PlanPreviewTask[]; total: number; pending: number; done: number; failed: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(planPath, 'utf-8');
  } catch (err) {
    // A workspace that has never been planned in (or one where a botched
    // revert wiped the plan) is a legitimate empty state, not a 500. The UI
    // shows "No tasks yet" and the user can plan via the goal box.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { tasks: [], total: 0, pending: 0, done: 0, failed: 0 };
    }
    throw err;
  }
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

async function readAutonomyCheckpointIteration(statePath = path.join(PROJECT_DIR, '.forge-state.json')): Promise<number> {
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as { iteration?: unknown };
    const iteration = typeof parsed.iteration === 'number' ? parsed.iteration : Number(parsed.iteration);
    if (!Number.isFinite(iteration) || iteration < 0) return 0;
    return Math.floor(iteration);
  } catch {
    return 0;
  }
}

app.get('/api/autonomy/plan-preview', async (_req, res) => {
  try {
    res.json({ planPath: 'IMPLEMENTATION_PLAN.md', ...(await readAutonomyPlanPreview()) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Unified inbox: aggregates the things that need the user's attention into
// one ranked list so the chat-first surface can show "3 things need you"
// without the user opening Permissions, Mission Control, and Runs tabs
// individually. Read-only and lossless — every item links back to its
// source endpoint via the `source` and `sourceUrl` fields. Failure of
// any single source degrades gracefully (empty list for that category)
// so the overall inbox never crashes the UI.
app.get('/api/inbox', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    const items: Array<{
      id: string;
      kind: 'permission' | 'plan_task' | 'automation_run';
      title: string;
      detail: string;
      timestamp: string;
      priority: number;
      action?: { kind: 'chat' | 'open_tab'; payload: string };
    }> = [];

    // 1. Pending permission prompts — highest priority because they block
    //    a tool call that is waiting on the user's decision right now.
    for (const prompt of permissionPrompts.list()) {
      items.push({
        id: `permission:${prompt.id}`,
        kind: 'permission',
        title: `Approve ${prompt.call.name}`,
        detail: prompt.classification?.explanation || prompt.reason || 'Tool call waiting on your decision.',
        timestamp: prompt.createdAt,
        priority: 100,
        action: { kind: 'open_tab', payload: 'tools' },
      });
    }

    // 2. Pending implementation plan tasks — work the user has queued for
    //    autonomy but has not started yet. Capped to the 5 next pending
    //    items so the inbox does not drown in long backlogs.
    try {
      const preview = await readAutonomyPlanPreview();
      const pendingTasks = (preview.tasks || []).filter((task) => task.status === 'pending').slice(0, 5);
      for (const task of pendingTasks) {
        items.push({
          id: `plan_task:${task.id}`,
          kind: 'plan_task',
          title: task.title,
          detail: 'Pending plan task in IMPLEMENTATION_PLAN.md',
          timestamp: new Date().toISOString(),
          priority: 60,
          action: { kind: 'open_tab', payload: 'autonomy' },
        });
      }
    } catch { /* no plan file yet — skip silently */ }

    // 3. Recent automation runs the user has not viewed — surface the most
    //    recent 5 so overnight work shows up the next time the user opens
    //    the chat. Failure runs sort above successes within this category.
    try {
      const runs = (await readAutomationRunLog(PROJECT_DIR, 50)).slice(0, 5);
      for (const run of runs) {
        const success = run.success !== false;
        items.push({
          id: `automation_run:${run.jobId}:${run.ranAt}`,
          kind: 'automation_run',
          title: (run.name || run.jobId) + (success ? ' completed' : ' failed'),
          detail: success ? 'Automation run finished — open Runs to see output.' : 'Automation run failed — open Runs to investigate.',
          timestamp: run.ranAt,
          priority: success ? 30 : 50,
          action: { kind: 'open_tab', payload: 'runs' },
        });
      }
    } catch { /* no run log yet — skip silently */ }

    // Rank: priority desc, then timestamp desc. Hard cap at 8 so the UI
    // strip stays glanceable; a "show all" link in the UI links to the
    // dedicated tabs.
    items.sort((a, b) => (b.priority - a.priority) || (b.timestamp.localeCompare(a.timestamp)));
    const top = items.slice(0, 8);
    res.json({ total: items.length, shown: top.length, items: top });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Parse a model's decomposition reply into clean { id, title } task steps.
// Primary path: a JSON array of objects with a `title`. Fallback: plain
// numbered / bulleted / checkbox lines. Titles are slugified to ids using
// the same rule as the manual task endpoint, then capped at 12 steps so a
// runaway reply can't flood the plan.
function parseGoalIntoTasks(text: string): { id: string; title: string }[] {
  const slug = (title: string): string =>
    title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const titles: string[] = [];

  const jsonStart = text.indexOf('[');
  const jsonEnd = text.lastIndexOf(']');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const title = typeof item === 'string'
            ? item
            : (item && typeof item.title === 'string' ? item.title : '');
          const trimmed = title.trim();
          if (trimmed) titles.push(trimmed);
        }
      }
    } catch {
      // Fall through to line parsing.
    }
  }

  if (titles.length === 0) {
    for (const rawLine of text.split(/\r?\n/)) {
      // Strip leading "- [ ] id —", "1.", "-", "*" markers, keep the title.
      const line = rawLine
        .replace(/^\s*[-*]\s*\[.\]\s*\S+\s*[—-]\s*/, '')
        .replace(/^\s*\d+[.)]\s*/, '')
        .replace(/^\s*[-*]\s*/, '')
        .trim();
      if (line && line.length <= 200 && !line.startsWith('#')) titles.push(line);
    }
  }

  const tasks: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    const id = slug(title);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tasks.push({ id, title });
    if (tasks.length >= 12) break;
  }
  return tasks;
}

app.post('/api/autonomy/tasks', async (req, res) => {
  try {
    const title = String(req.body?.title ?? '').trim();
    if (!title) { res.status(400).json({ error: 'Task title is required.' }); return; }
    const description = String(req.body?.description ?? title).trim();
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `task-${Date.now()}`;
    // Optional anchors (files the model should read for context) and target
    // (the file the model should edit). Mirror the markdown sub-bullet
    // format that parsePlan in cookbook/task-loop.ts already consumes,
    // so the loop reads them with no extra plumbing.
    const rawAnchors = Array.isArray(req.body?.anchors) ? req.body.anchors as unknown[] : [];
    const anchors = rawAnchors.map((a) => String(a ?? '').trim()).filter(Boolean).slice(0, 10);
    const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
    const planPath = path.join(PROJECT_DIR, 'IMPLEMENTATION_PLAN.md');
    let existing = '';
    try { existing = await fs.readFile(planPath, 'utf-8'); } catch { existing = '# Implementation Plan\n'; }
    // Reject the "pasted-back plan line" case: if the title's first
    // whitespace-separated token is already a task id in the plan, we would
    // otherwise slugify the whole pasted blob, bump a suffix, and produce a
    // Frankenstein title like `slug--3 — slug--2 — slug- — …` that nests
    // deeper on every re-add. Mirrors the /goal slash-command defense.
    const existingIds = new Set<string>();
    for (const planLine of existing.split(/\r?\n/)) {
      const m = planLine.match(/^- \[.\] (\S+)\s+[—-]/);
      if (m) existingIds.add(m[1].toLowerCase());
    }
    const leadingToken = title.split(/\s+/)[0]?.toLowerCase();
    if (leadingToken && existingIds.has(leadingToken)) {
      res.status(409).json({ error: `Task "${leadingToken}" already exists. To re-run it use the existing task; to add a new one, rephrase without the task id at the start.` });
      return;
    }
    const subBullets = [
      ...anchors.map((a) => `  - anchor: ${a}`),
      ...(target ? [`  - target: ${target}`] : []),
    ].join('\n');
    const entry = `\n- [ ] ${id} — ${description}` + (subBullets ? `\n${subBullets}` : '') + '\n';
    await fs.writeFile(planPath, existing.replace(/\n*$/, '') + entry, 'utf-8');
    const preview = await readAutonomyPlanPreview();
    res.json({ ok: true, id, title: description, ...preview });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Turn a plain-English goal into an ordered list of build steps. Powers the
// non-technical "Build Mode": the user describes what they want, the model
// decomposes it into tasks, and we append them to the same
// IMPLEMENTATION_PLAN.md the autonomy loop already consumes. We APPEND (never
// overwrite) so an existing plan is never destroyed.
app.post('/api/autonomy/plan-from-goal', async (req, res) => {
  try {
    const goal = String(req.body?.goal ?? '').trim();
    if (!goal) { res.status(400).json({ error: 'Please describe what you want to build.' }); return; }
    if (goal.length > 4000) { res.status(400).json({ error: 'That description is very long — please shorten it to under 4000 characters.' }); return; }
    const model = String(req.body?.model ?? currentModel ?? '').trim();
    if (!model) { res.status(400).json({ error: 'No AI model is selected yet. Pick a model first, then try again.' }); return; }

    const systemPrompt = [
      'You are a planning assistant for a non-technical user. Break their request into a short, ordered list of concrete build steps an autonomous coding agent can carry out one at a time.',
      'Rules:',
      '- 3 to 10 steps. Fewer is better for a small request.',
      '- Each step is one self-contained unit of work with a clear, plain-English title (max ~12 words).',
      '- Order steps so each builds on the previous: scaffold/setup first, then features, then polish.',
      '- Every step must CREATE or MODIFY real files or code that move the build forward.',
      '- Never add steps that only read, inspect, analyze, summarize, or document — the agent reads whatever context it needs on its own. Those steps produce no buildable output and stall the run.',
      '- Prefer concrete deliverables (e.g. "Create the data model in models.py") over vague phases (e.g. "Analyze the requirements").',
      '- Do not include steps about asking the user questions, deployment, or anything outside building the thing.',
      '- Respond with ONLY a JSON array, no prose and no code fences. Each element: {"title": "..."}.',
    ].join('\n');

    const client = webRuntime.createClient(model, ollamaHost);
    let modelText = '';
    try {
      const result = await client.chatOnce([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: goal },
      ]);
      modelText = result.message?.content ?? '';
    } catch (modelErr) {
      const detail = modelErr instanceof Error ? modelErr.message : String(modelErr);
      res.status(502).json({ error: `I couldn't reach the AI model. Is it running? (${detail})` });
      return;
    }

    const steps = parseGoalIntoTasks(modelText);
    if (steps.length === 0) {
      res.status(502).json({ error: 'The model did not return a usable plan. Try rephrasing your idea, or add steps manually below.' });
      return;
    }

    // A single un-validated model response occasionally returns a bloated or
    // repetitive plan (a real run once stalled on a ~38-task list full of
    // near-duplicates). Dedupe by a normalized title and cap the count so one
    // over-eager response can't flood IMPLEMENTATION_PLAN.md. First occurrence
    // wins, so order is preserved.
    const MAX_PLAN_STEPS = 12;
    const seenTitles = new Set<string>();
    const dedupedSteps: typeof steps = [];
    for (const step of steps) {
      const normTitle = step.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normTitle || seenTitles.has(normTitle)) continue;
      seenTitles.add(normTitle);
      dedupedSteps.push(step);
      if (dedupedSteps.length >= MAX_PLAN_STEPS) break;
    }
    if (dedupedSteps.length === 0) {
      res.status(502).json({ error: 'The model did not return a usable plan. Try rephrasing your idea, or add steps manually below.' });
      return;
    }

    // If the user's goal mentions paths outside the workspace (drive letters
    // like H:\Model, or /Users/, /home/, /mnt/, /Volumes/ on POSIX), every
    // generated step is auto-tagged kind:external. External tasks routinely
    // write their output outside PROJECT_DIR and have no meaningful in-repo
    // typecheck signal, so the autonomy loop validates them by artifact
    // existence + runbook, not by `npm run typecheck`. Without this tag, a
    // perfectly successful "read H:\Model and write inventory" task fails
    // validation in any non-TS workspace and gets reverted. We also extract
    // the specific path and stamp it on every step (as a `target:` sub-
    // bullet AND inside the step title) so the agent's per-task prompt
    // anchors every step at the same folder; without this, step 1 says
    // "read H:\Model" but steps 2-N say generic things like "implement the
    // model architecture" with no idea WHERE to write, and the model
    // wanders out of scope.
    const externalPathPattern = /(?:[A-Z]:[\\/]|\/(?:Users|home|mnt|Volumes)\/)/i;
    const goalMentionsExternalPath = externalPathPattern.test(goal);
    const externalPathExtractPattern = /[A-Z]:[\\/][^\s'"<>|?*]+|\/(?:Users|home|mnt|Volumes)\/[^\s'"<>|?*]+/i;
    const externalPathMatch = goalMentionsExternalPath ? goal.match(externalPathExtractPattern) : null;
    const externalTargetPath = externalPathMatch
      ? externalPathMatch[0].replace(/[.,;:!?)\]]+$/, '')
      : null;

    const planPath = path.join(PROJECT_DIR, 'IMPLEMENTATION_PLAN.md');
    let existing = '';
    try { existing = await fs.readFile(planPath, 'utf-8'); } catch { existing = '# Implementation Plan\n'; }
    const existingIds = new Set<string>();
    for (const planLine of existing.split(/\r?\n/)) {
      const m = planLine.match(/^- \[.\] (\S+)\s+[—-]/);
      if (m) existingIds.add(m[1].toLowerCase());
    }
    const added: { id: string; title: string }[] = [];
    const entries: string[] = [];
    for (const step of dedupedSteps) {
      let uniqueId = step.id;
      let suffix = 2;
      while (existingIds.has(uniqueId)) { uniqueId = `${step.id}-${suffix++}`; }
      existingIds.add(uniqueId);
      const stepIsExternal = goalMentionsExternalPath || externalPathPattern.test(step.title);
      // Inject the external path into the step title when the model omitted
      // it. Steps after the first commonly say "implement the model" with
      // no folder reference; without this, the agent's per-task prompt
      // (which embeds the title verbatim) gives no hint where to write.
      const stepTitle = stepIsExternal && externalTargetPath && !step.title.includes(externalTargetPath)
        ? `${step.title} in ${externalTargetPath}`
        : step.title;
      added.push({ id: uniqueId, title: stepTitle });
      const kindLine = stepIsExternal ? '\n  - kind: external' : '';
      const targetLine = stepIsExternal && externalTargetPath ? `\n  - target: ${externalTargetPath}` : '';
      entries.push(`\n- [ ] ${uniqueId} — ${stepTitle}${kindLine}${targetLine}`);
    }
    await fs.writeFile(planPath, existing.replace(/\n*$/, '') + entries.join('') + '\n', 'utf-8');
    const preview = await readAutonomyPlanPreview();
    res.json({ ok: true, goal, added, ...preview });
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
    const requestedMaxIterations = Math.max(1, Math.floor(Number(req.body?.maxIterations ?? 1) || 1));
    const requestedMaxTurns = Math.max(1, Math.min(500, Math.floor(Number(req.body?.maxTurns ?? process.env.HARNESS_MAX_TURNS ?? 30) || 30)));
    const requestedUnproductiveTurnLimit = Math.max(1, Math.min(100, Math.floor(Number(req.body?.unproductiveTurnLimit ?? 6) || 6)));
    const checkpointIteration = await readAutonomyCheckpointIteration();
    const effectiveMaxIterations = checkpointIteration + requestedMaxIterations;
    const env = sanitizeSpawnEnv(process.env);
    const setEnv = (key: string, value: unknown): void => {
      if (value === undefined || value === null || value === '') return;
      env[key] = String(value);
    };
    setEnv('HARNESS_MODEL', req.body?.model ?? currentModel);
    setEnv('HARNESS_BACKEND', req.body?.backend);
    setEnv('HARNESS_PERMISSION_MODE', req.body?.permissionMode ?? permissionMode);
    setEnv('FORGE_MAX_ITERATIONS', effectiveMaxIterations);
    setEnv('HARNESS_MAX_TURNS', requestedMaxTurns);
    setEnv('HARNESS_TIME_BUDGET_MS', req.body?.timeBudgetMs);
    setEnv('HARNESS_UNPRODUCTIVE_TURN_LIMIT', requestedUnproductiveTurnLimit);
    await fs.rm(path.join(PROJECT_DIR, '.forge-stop'), { force: true }).catch((err) => recordSwallowed('fs.rm', err));
    autonomyStartedAt = new Date().toISOString();
    // The autonomy loop (cookbook/task-loop.ts) lives in the harness repo,
    // not in the user's project workspace. Previously we spawned
    // `npm run autonomy` with cwd=PROJECT_DIR, which failed with
    // "Missing script: autonomy" whenever PROJECT_DIR was an isolated
    // workspace. Instead, launch the repo's loop directly with Node +
    // ts-node while keeping cwd=PROJECT_DIR so the loop reads/writes the
    // plan, logs, state, and git in the workspace. HARNESS_HOME lets the
    // loop locate the compiled CLI (dist/cli/index.js) in the repo.
    const harnessHome = path.join(__dirname, '..', '..');
    const tsNodeRegister = path.join(harnessHome, 'node_modules', 'ts-node', 'register', 'transpile-only');
    const taskLoopEntry = path.join(harnessHome, 'cookbook', 'task-loop.ts');
    const loopArgs = ['-r', tsNodeRegister, taskLoopEntry];
    env.HARNESS_HOME = harnessHome;
    env.TS_NODE_TRANSPILE_ONLY = '1';
    env.TS_NODE_PROJECT = path.join(harnessHome, 'tsconfig.json');
    try {
      autonomyChild = spawn(process.execPath, loopArgs, { cwd: PROJECT_DIR, env });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL') throw error;
      logger.warn('Autonomy', 'Primary spawn failed with EINVAL; retrying with minimal env', { code });
      const minimalEnv = buildMinimalWindowsSpawnEnv(env);
      minimalEnv.HARNESS_HOME = harnessHome;
      minimalEnv.TS_NODE_TRANSPILE_ONLY = '1';
      minimalEnv.TS_NODE_PROJECT = path.join(harnessHome, 'tsconfig.json');
      autonomyChild = spawn(process.execPath, loopArgs, { cwd: PROJECT_DIR, env: minimalEnv });
    }
    // Mirror the child's stdout/stderr into .forge-run.log so failures that
    // happen before task-loop.ts installs its uncaughtException handler
    // (e.g. ts-node compile errors, missing modules) still surface in the
    // autonomy log dialog as readable text instead of being lost on stderr.
    const autonomyLogPath = path.join(PROJECT_DIR, '.forge-run.log');
    const mirrorChildChunk = (prefix: 'STDOUT' | 'STDERR', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        fs.appendFile(autonomyLogPath, `[${new Date().toISOString()}] ${prefix} ${line}\n`).catch((err) => recordSwallowed('autonomyChildMirror', err));
      }
    };
    autonomyChild.stdout?.on('data', (chunk: Buffer) => mirrorChildChunk('STDOUT', chunk));
    autonomyChild.stderr?.on('data', (chunk: Buffer) => mirrorChildChunk('STDERR', chunk));
    autonomyChild.on('error', (err) => {
      fs.appendFile(autonomyLogPath, `[${new Date().toISOString()}] FATAL spawn error: ${err.message}\n`).catch((swallowErr) => recordSwallowed('autonomyChildMirror', swallowErr));
    });
    const evidence = createRunEvidence({ id: `autonomy:${autonomyStartedAt}`, kind: 'autonomy', request: preview.tasks.find((task) => task.status === 'pending')?.title || 'Run next pending implementation task', runName: 'Ralph autonomy loop', command: 'node -r ts-node/register/transpile-only cookbook/task-loop.ts', success: true, summary: `Started with ${preview.pending} pending task(s).` });
    await appendRunEvidence(PROJECT_DIR, evidence);
    autonomyChild.on('exit', () => { autonomyChild = null; autonomyStartedAt = undefined; });
    res.json({ ok: true, startedAt: autonomyStartedAt, pid: autonomyChild.pid, pending: preview.pending, requestedMaxIterations, requestedMaxTurns, requestedUnproductiveTurnLimit, effectiveMaxIterations, checkpointIteration, evidence });
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

app.post('/api/autonomy/reset', async (_req, res) => {
  try {
    const cleared: string[] = [];
    const toClear = ['.forge-stop', '.forge-state.json'];
    for (const file of toClear) {
      const fullPath = path.join(PROJECT_DIR, file);
      try {
        await fs.access(fullPath);
        await fs.rm(fullPath, { force: true });
        cleared.push(file);
      } catch {
        // Missing files are fine for idempotent reset.
      }
    }
    const wasRunning = Boolean(autonomyChild && !autonomyChild.killed);
    if (wasRunning) autonomyChild?.kill();
    autonomyChild = null;
    autonomyStartedAt = undefined;
    const evidence = createRunEvidence({
      id: `autonomy-reset:${new Date().toISOString()}`,
      kind: 'autonomy',
      request: 'Reset autonomy run state',
      runName: 'Ralph autonomy loop',
      command: 'clear .forge-stop/.forge-state.json',
      success: true,
      summary: `Cleared ${cleared.length} file(s).${wasRunning ? ' Active run stopped.' : ''}`,
    });
    await appendRunEvidence(PROJECT_DIR, evidence);
    res.json({ ok: true, cleared, stopped: wasRunning, evidence });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// List available models from Ollama
// Cache of the most recent tool-calling probe per model id. Tool-calling
// capability is a property of the model+backend, so a single verified/failed
// verdict stays valid until the user explicitly re-probes. Keeps /api/readiness
// fast (no network call per poll) while still surfacing real, measured results.
const toolCallProbeCache = new Map<string, ToolCallProbeResult>();

// Actively verify whether the *current* model emits tool calls. This is an
// on-demand, explicit action (never auto-run) so cloud models are not probed —
// and charged — without the user asking. Result is cached for /api/readiness.
app.post('/api/model/probe-tools', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    if (!currentModel) {
      res.status(400).json({ error: 'No model selected.' });
      return;
    }
    const client = webRuntime.createClient(currentModel, ollamaHost);
    const result = await probeToolCalling(client);
    toolCallProbeCache.set(currentModel, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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
          capabilities: inferModelCapabilities(`${backendId}/${m.id}`, {}),
          backend: backendId,
        });
      }
    }
    if (readApiKey(REPLICATE_PRESET)) {
      for (const m of (REMOTE_MODEL_CATALOG.replicate || [])) {
        models.push({
          name: 'replicate/' + m.id,
          parameterSize: m.label,
          capabilities: inferModelCapabilities(`replicate/${m.id}`, {}),
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
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)' },
    { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)' },
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
    if (!requireEscalationAuth(req, res, 'API key update')) return;
    const incoming = req.body && typeof req.body === 'object' ? req.body : {};
    const stored = await readStoredApiKeysFile();
    let changed = false;
    for (const [name, rawValue] of Object.entries(incoming)) {
      if (!ALLOWED_API_KEY_NAMES.has(name)) continue;
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (value) {
        stored[name] = value;
        // Always update process.env when the value is file-sourced or not
        // yet set. Only preserve env-var values that the user set outside
        // the UI (i.e. not previously stored via this endpoint).
        if (!process.env[name] || !process.env[name]!.trim() || FILE_SOURCED_KEYS.has(name)) {
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
      await withFileLock(API_KEYS_PATH, () => atomicWriteFile(API_KEYS_PATH, JSON.stringify(stored, null, 2), { encoding: 'utf-8', mode: 0o600 }));
    }
    res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Test SMTP connectivity without sending an email. Uses nodemailer's
// verify() which authenticates against the server and checks readiness.
app.post('/api/smtp-test', async (_req, res) => {
  const host = process.env.HARNESS_SMTP_HOST?.trim();
  const port = parseInt(process.env.HARNESS_SMTP_PORT ?? '587', 10);
  const user = process.env.HARNESS_SMTP_USER?.trim();
  // Strip internal spaces from the password — Google App Passwords are
  // displayed as "xxxx xxxx xxxx xxxx" but SMTP auth needs them joined.
  const pass = process.env.HARNESS_SMTP_PASS?.trim().replace(/\s+/g, '');

  if (!host || !user || !pass) {
    res.json({ ok: false, error: 'SMTP not configured. Save HARNESS_SMTP_HOST, HARNESS_SMTP_USER, and HARNESS_SMTP_PASS first.' });
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    await transporter.verify();
    transporter.close();
    res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.json({ ok: false, error: `${msg} (host: ${host}, port: ${port}, user: ${user})` });
  }
});

// Send an email directly from the settings compose form.
app.post('/api/email/send', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    if (!requireEscalationAuth(req, res, 'email send')) return;
    const to = String(req.body?.to ?? '').trim();
    const subject = String(req.body?.subject ?? '').trim();
    const body = String(req.body?.body ?? '').trim();
    if (!to || !subject || !body) {
      res.status(400).json({ error: 'To, subject, and body are required.' });
      return;
    }
    const toAddresses = to.split(',').map((a: string) => a.trim()).filter(Boolean);
    for (const addr of toAddresses) {
      if (!addr.includes('@') || !addr.includes('.')) {
        res.status(400).json({ error: `Invalid email address: ${addr}` });
        return;
      }
    }
    const host = process.env.HARNESS_SMTP_HOST?.trim();
    const port = parseInt(process.env.HARNESS_SMTP_PORT ?? '587', 10);
    const user = process.env.HARNESS_SMTP_USER?.trim();
    const pass = process.env.HARNESS_SMTP_PASS?.trim().replace(/\s+/g, '');
    const from = process.env.HARNESS_SMTP_FROM?.trim() || user;
    if (!host || !user || !pass) {
      res.status(400).json({ error: 'SMTP not configured. Save SMTP credentials first.' });
      return;
    }
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    // Build attachment list from optional base64-encoded files.
    const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const mailAttachments: Array<{ filename: string; content: Buffer }> = [];
    for (const att of rawAttachments.slice(0, 10)) {
      const name = String(att?.filename ?? 'attachment').replace(/[/\\]/g, '_');
      const b64 = String(att?.content ?? '');
      if (!b64) continue;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 10 * 1024 * 1024) {
        res.status(400).json({ error: `Attachment "${name}" exceeds 10 MB limit.` });
        return;
      }
      mailAttachments.push({ filename: name, content: buf });
    }
    const info = await transporter.sendMail({
      from: from ? `Harness <${from}>` : undefined,
      to: toAddresses.join(', '),
      subject,
      ...(req.body?.html ? { html: body } : { text: body }),
      attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
    });
    // Archive sent copy.
    const sentDir = path.join(PROJECT_DIR, '.harness', 'email', 'sent');
    await fs.mkdir(sentDir, { recursive: true });
    const safeSubject = subject.replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 50).trim().replace(/\s+/g, '-') || 'sent';
    const filename = `${safeSubject}-${Date.now()}.eml`;
    const emlContent = `From: ${from}\r\nTo: ${toAddresses.join(', ')}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: ${info.messageId}\r\n\r\n${body}\r\n`;
    await fs.writeFile(path.join(sentDir, filename), emlContent, 'utf-8');
    res.json({ ok: true, messageId: info.messageId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// List email drafts and sent emails for the preview panel.
app.get('/api/email/list', async (_req, res) => {
  const draftsDir = path.join(PROJECT_DIR, '.harness', 'email', 'drafts');
  const sentDir = path.join(PROJECT_DIR, '.harness', 'email', 'sent');
  const results: Array<{ name: string; folder: 'drafts' | 'sent'; modified: string }> = [];
  for (const [dir, folder] of [[draftsDir, 'drafts'], [sentDir, 'sent']] as const) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.eml')) continue;
        try {
          const stat = await fs.stat(path.join(dir, file));
          results.push({ name: file, folder, modified: stat.mtime.toISOString() });
        } catch { /* skip unreadable */ }
      }
    } catch { /* directory doesn't exist yet */ }
  }
  results.sort((a, b) => b.modified.localeCompare(a.modified));
  res.json({ emails: results.slice(0, 50) });
});

// Read the content of a single draft/sent .eml file.
app.get('/api/email/read', async (req, res) => {
  const folder = req.query.folder === 'sent' ? 'sent' : 'drafts';
  const name = String(req.query.name ?? '');
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    res.status(400).json({ error: 'Invalid filename.' });
    return;
  }
  const filePath = path.join(PROJECT_DIR, '.harness', 'email', folder, name);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    res.json({ name, folder, content });
  } catch {
    res.status(404).json({ error: 'File not found.' });
  }
});

// Save a compose-in-progress draft.
app.put('/api/email/draft', async (req, res) => {
  const to = String(req.body?.to ?? '').trim();
  const subject = String(req.body?.subject ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  if (!to && !subject && !body) { res.json({ ok: false, reason: 'empty' }); return; }
  const draftsDir = path.join(PROJECT_DIR, '.harness', 'email', 'drafts');
  await fs.mkdir(draftsDir, { recursive: true });
  const filename = 'compose-autosave.eml';
  const emlContent = `To: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\n\r\n${body}\r\n`;
  await fs.writeFile(path.join(draftsDir, filename), emlContent, 'utf-8');
  res.json({ ok: true, filename });
});

app.delete('/api/email/delete', async (req, res) => {
  const folder = req.query.folder === 'sent' ? 'sent' : 'drafts';
  const name = String(req.query.name ?? '');
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\') || !name.endsWith('.eml')) {
    res.status(400).json({ error: 'Invalid filename.' });
    return;
  }
  const filePath = path.join(PROJECT_DIR, '.harness', 'email', folder, name);
  try {
    await fs.unlink(filePath);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'File not found.' });
  }
});

// ─── Email templates ──────────────────────────────────────────────────

const EMAIL_TEMPLATES_PATH = path.join(PROJECT_DIR, '.harness', 'email', 'templates.json');

async function readEmailTemplates(): Promise<Array<{ name: string; to: string; subject: string; body: string; html?: boolean; category?: string }>> {
  try {
    const raw = await fs.readFile(EMAIL_TEMPLATES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

app.get('/api/email/templates', async (_req, res) => {
  res.json({ templates: await readEmailTemplates() });
});

app.post('/api/email/templates', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) { res.status(400).json({ error: 'Template name is required.' }); return; }
  const template = {
    name,
    to: String(req.body?.to ?? '').trim(),
    subject: String(req.body?.subject ?? '').trim(),
    body: String(req.body?.body ?? '').trim(),
    ...(req.body?.html ? { html: true } : {}),
    ...(typeof req.body?.category === 'string' && req.body.category.trim() ? { category: String(req.body.category).trim().slice(0, 60) } : {}),
  };
  const count = await withFileLock(EMAIL_TEMPLATES_PATH, async () => {
    const templates = await readEmailTemplates();
    const idx = templates.findIndex((t) => t.name === name);
    if (idx >= 0) templates[idx] = template; else templates.push(template);
    await atomicWriteFile(EMAIL_TEMPLATES_PATH, JSON.stringify(templates, null, 2));
    return templates.length;
  });
  res.json({ ok: true, count });
});

app.delete('/api/email/templates', async (req, res) => {
  const name = String(req.query.name ?? '').trim();
  if (!name) { res.status(400).json({ error: 'Template name is required.' }); return; }
  const count = await withFileLock(EMAIL_TEMPLATES_PATH, async () => {
    const templates = await readEmailTemplates();
    const filtered = templates.filter((t) => t.name !== name);
    await atomicWriteFile(EMAIL_TEMPLATES_PATH, JSON.stringify(filtered, null, 2));
    return filtered.length;
  });
  res.json({ ok: true, count });
});

async function readStoredApiKeysFile(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(API_KEYS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

async function writeStoredApiKeysFile(stored: Record<string, string>): Promise<void> {
  await atomicWriteFile(API_KEYS_PATH, JSON.stringify(stored, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

async function storeConnectorSecret(name: string, value: string): Promise<void> {
  if (!ALLOWED_API_KEY_NAMES.has(name)) return;
  await withFileLock(API_KEYS_PATH, async () => {
    const stored = await readStoredApiKeysFile();
    const trimmed = value.trim();
    if (trimmed) {
      stored[name] = trimmed;
      if (!process.env[name] || !process.env[name]!.trim()) process.env[name] = trimmed;
      FILE_SOURCED_KEYS.add(name);
    } else {
      delete stored[name];
      if (FILE_SOURCED_KEYS.has(name)) {
        delete process.env[name];
        FILE_SOURCED_KEYS.delete(name);
      }
    }
    await writeStoredApiKeysFile(stored);
  });
}

// File-write redirect rules. Routes extracted to ./fileRedirectRoutes.ts.
app.use(createFileRedirectRouter({ projectDir: PROJECT_DIR }));

// Get/set current settings
app.get('/api/settings', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    checkAutonomyExpiry();
    res.json(await getPublicSettings());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// ─── Synthesis stats (adaptive maxTurns / time budget) ──────────────
// GET reads the per-model stats file + computes adaptive limits; DELETE
// clears one model (?model=) or all. Extracted to ./synthesisStatsRoutes.ts.
// server.ts keeps loadSynthesisStats + adaptiveMaxTurns + adaptiveTimeBudget
// imports (chat handler at line ~5829 still uses them); only clearSynthesisStats
// was dropped from the server.ts import.
app.use(createSynthesisStatsRouter({ projectDir: PROJECT_DIR }));

app.post('/api/settings', async (req, res) => {
  await ensureSettingsLoaded();
  let permissionModeAuditNote = '';
  if (req.body.model !== undefined) currentModel = sanitizeModelName(req.body.model);
  if (req.body.permissionMode !== undefined) {
    if (!ALLOWED_PERMISSION_MODES.includes(req.body.permissionMode)) {
      res.status(400).json({ error: 'Invalid permission mode.' });
      return;
    }
    if (req.body.permissionMode !== permissionMode) {
      if (!requireEscalationAuth(req, res, 'permission mode change')) return;
      if (req.body.permissionMode === 'dontAsk') {
        const reason = requireAuditReason(req.body?.reason, res, 'Escalating permission mode to dontAsk');
        if (!reason) return;
        permissionModeAuditNote = reason;
      } else {
        permissionModeAuditNote = parseAuditReason(req.body?.reason);
      }
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
  if (req.body.teammate !== undefined) {
    teammateSettings = sanitizeTeammateSettings(req.body.teammate);
    configureTeammateScheduler();
  }
  if (req.body.modelDebugLog !== undefined) {
    modelDebugLog = sanitizeModelDebugLogSettings(req.body.modelDebugLog);
    applyModelDebugLogEnvironment(modelDebugLog);
  }
  configureAutomationScheduler();
  if (req.body.contextMaxTokens !== undefined) contextMaxTokens = clampNumber(req.body.contextMaxTokens, 0, 200_000, DEFAULT_CONTEXT_MAX_TOKENS);
  if (req.body.webReadMaxChars !== undefined) {
    webReadMaxChars = sanitizeWebReadMaxChars(req.body.webReadMaxChars, DEFAULT_WEB_READ_MAX_CHARS);
    configureWebReadTool({ maxChars: webReadMaxChars });
  }
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
  if (req.body.discordBotToken !== undefined) await storeConnectorSecret('HARNESS_DISCORD_BOT_TOKEN', String(req.body.discordBotToken).trim().slice(0, 200));
  if (req.body.discordAllowedChannelIds !== undefined) discordAllowedChannelIds = String(req.body.discordAllowedChannelIds).trim().slice(0, 500);
  if (req.body.slackWebhookUrl !== undefined) {
    await storeConnectorSecret('HARNESS_SLACK_WEBHOOK_URL', sanitizeSlackWebhookUrl(req.body.slackWebhookUrl));
  }
  if (req.body.whatsappAccessToken !== undefined || req.body.whatsappPhoneNumberId !== undefined || req.body.whatsappAllowedRecipients !== undefined) {
    const sanitized = sanitizeWhatsAppSetup({
      accessToken: req.body.whatsappAccessToken ?? connectorSecretValue('HARNESS_WHATSAPP_ACCESS_TOKEN'),
      phoneNumberId: req.body.whatsappPhoneNumberId ?? whatsappPhoneNumberId,
      allowedRecipients: req.body.whatsappAllowedRecipients ?? whatsappAllowedRecipients,
    });
    await storeConnectorSecret('HARNESS_WHATSAPP_ACCESS_TOKEN', sanitized.accessToken);
    whatsappPhoneNumberId = sanitized.phoneNumberId;
    whatsappAllowedRecipients = sanitized.allowedRecipients;
    if (whatsappPhoneNumberId) process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID = whatsappPhoneNumberId;
    else delete process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID;
    if (whatsappAllowedRecipients) process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS = whatsappAllowedRecipients;
    else delete process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS;
  }
  if (req.body.ccmemUrl !== undefined) {
    const parsed = typeof req.body.ccmemUrl === 'string' ? req.body.ccmemUrl.trim() : '';
    ccmemUrl = parsed;
    setCcmemUrl(ccmemUrl || 'http://localhost:8765');
  }
  if (req.body.browserRedaction !== undefined) browserRedaction = sanitizeBrowserRedaction(req.body.browserRedaction);
  await saveSettingsToDisk();
  logger.info('Settings', 'Updated', {
    model: currentModel,
    permissionMode,
    temperature,
    topP,
    permissionModeReason: permissionModeAuditNote || undefined,
  });
  res.json(await getPublicSettings());
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
    // Anchor the profile suggestion to the mode classifier so research/maintain
    // prompts cannot get graded against the coding-answer rubric just because
    // they mention a file path or language name.
    const modeHint = input ? classifyMode(input).mode : undefined;
    const suggestion = describeOutputValidationProfileSuggestion(input, 'oracle-prime', { modeHint });
    const metadata = OUTPUT_VALIDATION_PROFILES.find((candidate) => candidate.profile === suggestion.profile);
    res.json({ profile: suggestion.profile, label: metadata?.label ?? suggestion.profile, reason: suggestionReason(suggestion.profile, suggestion.matched, modeHint), matched: suggestion.matched });
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
  return paths.map((filePath) => evidenceFileSummary(filePath, fileAction));
}

function evidenceFileSummary(filePath: string, action: EvidenceFileSummary['action']): EvidenceFileSummary {
  if (action !== 'write') return { path: filePath, action };
  const patternRedirect = applyFileWriteRedirect(filePath);
  if (patternRedirect) {
    return { path: patternRedirect, requestedPath: filePath, redirected: true, redirectKind: 'pattern', action };
  }
  const agentOutputRedirect = maybeRedirectAgentOutput(filePath);
  if (agentOutputRedirect) {
    return { path: agentOutputRedirect, requestedPath: filePath, redirected: true, redirectKind: 'agent-outputs', action };
  }
  return { path: filePath, action };
}

function checkToolEnabled(toolName: string): ReadinessCheck {
  return !isToolEnabled(toolName)
    ? { id: `tool.${toolName}`, label: `${toolName} enabled`, status: 'blocked', message: `${toolName} is disabled.`, action: 'Open Tools' }
    : { id: `tool.${toolName}`, label: `${toolName} enabled`, status: 'ready', message: `${toolName} is available.` };
}

// Tool-calling readiness for the current model. Prefers a measured probe
// result (cached from /api/model/probe-tools) over the static name heuristic,
// so users see whether their model *actually* calls tools rather than a guess.
function toolCallingReadinessCheck(): ReadinessCheck {
  const id = 'model.toolCalling';
  const label = 'Tool calling verified';
  if (!currentModel) {
    return { id, label, status: 'warn', message: 'No model selected.', action: 'Pick a model' };
  }
  const probed = toolCallProbeCache.get(currentModel);
  if (probed) {
    if (probed.verdict === 'verified') {
      return { id, label, status: 'ready', message: probed.message };
    }
    if (probed.verdict === 'failed') {
      return { id, label, status: 'blocked', message: probed.message, action: 'Pick a model' };
    }
    return { id, label, status: 'warn', message: probed.message, action: 'Probe model' };
  }
  const toolUse = inferModelCapabilities(currentModel).toolUse;
  if (toolUse === 'strong') {
    return { id, label, status: 'ready', message: `${currentModel} is expected to support tool calling (not yet verified). Probe to confirm.`, action: 'Probe model' };
  }
  if (toolUse === 'weak') {
    return { id, label, status: 'warn', message: `${currentModel} may not reliably call tools. Probe to verify, or pick a stronger model for research/file tasks.`, action: 'Probe model' };
  }
  return { id, label, status: 'warn', message: `Tool calling not yet verified for ${currentModel}. Probe before research, file, or automation tasks.`, action: 'Probe model' };
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
    // Validation scripts (npm test + typecheck/lint) are a code-quality
    // signal, not a precondition for autonomy. A research task with
    // kind:external has no use for them; gating all runs on their
    // presence locked first-time users out of the loop entirely. The
    // /api/readiness section reports the same check as 'warn'; mirror
    // that here.
    { id: 'validation.scripts', label: 'Validation scripts', status: setup.local.package.ok ? 'ready' : 'warn', message: setup.local.package.message, action: 'Run doctor' },
    checkToolEnabled('bash'),
    checkToolEnabled('file_edit'),
    checkToolEnabled('file_write'),
    { id: 'permission.mode', label: 'Permission mode', status: permissionMode === 'dontAsk' ? 'ready' : 'blocked', message: permissionMode === 'dontAsk' && autonomyExpiresAt > Date.now() ? `dontAsk (timed, ${formatMinutesRemaining(autonomyExpiresAt)} remaining)` : `Current mode is ${permissionMode}.` },
    { id: 'shell.grant', label: 'Shell grant', status: grantIds.has('arbitrary-shell') || permissionMode === 'dontAsk' ? 'ready' : 'blocked', message: grantIds.has('arbitrary-shell') || permissionMode === 'dontAsk' ? 'Shell capability is grant-ready.' : 'Shell execution needs an active grant.' },
    { id: 'background.autonomy.grant', label: 'Background autonomy grant', status: grantIds.has('background-autonomous-jobs') || permissionMode === 'dontAsk' ? 'ready' : 'blocked', message: grantIds.has('background-autonomous-jobs') || permissionMode === 'dontAsk' ? 'Background autonomy capability is grant-ready.' : 'Background jobs need an active grant.' },
  ];
  return { blocked: checks.filter((check) => check.status === 'blocked'), warnings: checks.filter((check) => check.status === 'warn') };
}

// Silent-failure diagnostics. Returns the in-memory ring buffer of promise
// rejections that the server's many fire-and-forget .catch() handlers
// recorded since process start. Used to surface failures of the audit log
// itself (emitEvent, saveSettingsToDisk, etc.) that would otherwise be
// completely invisible. Bounded at 200 entries; oldest evicted first.

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
    // v0.5.7: read kill-switch state from the canonical KillSwitch object
    // (audit item #10). The module-level mirror is kept in lockstep but is
    // no longer the read path for any public HTTP surface in this file.
    const killSnapshot = killSwitch.snapshot();
    // Resolve the *effective* context window so the readiness check
    // never reports "0 tokens" when the user is on auto. 0 is the
    // documented sentinel for auto-detect (see ui/index.html
    // contextMaxTokens input title); the raw configured value would
    // mislead, so we surface effective + mode + detected via
    // buildContextHealth() which also honours per-model profile caps.
    const contextHealth = await buildContextHealth().catch(() => null);
    const effectiveCtx = contextHealth?.effective ?? contextMaxTokens;
    const ctxMode = contextHealth?.mode ?? (isAutoContextMode(contextMaxTokens) ? 'auto' : 'capped');
    const ctxDetected = contextHealth?.detected ?? detectedContextMaxTokens;
    const ctxMessage = ctxMode === 'auto'
      ? (ctxDetected
          ? `Auto-sized to ${effectiveCtx} tokens from the model's ${ctxDetected}-token window.`
          : `Auto (model window not yet detected; using ${effectiveCtx}-token fallback).`)
      : `Configured cap of ${effectiveCtx} tokens${ctxDetected ? ` (model exposes ${ctxDetected}).` : '.'}`;
    const sections = [
      readinessSection('chat', 'Chat', [
        { id: 'model.selected', label: 'Model selected', status: modelSelected ? 'ready' : 'blocked', message: modelSelected ? `Selected ${currentModel}.` : 'No model selected.', action: 'Pick a model' },
        { id: 'model.health', label: 'Model backend health', status: modelHealthy ? 'ready' : 'blocked', message: modelHealthy ? `${modelBackend} backend is available.` : `${modelBackend} backend is not ready.`, action: 'Open Settings' },
        toolCallingReadinessCheck(),
        { id: 'context.window', label: 'Context window', status: effectiveCtx >= 4096 ? 'ready' : 'warn', message: ctxMessage },
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
        { id: 'kill.switch', label: 'Kill switch clear', status: killSnapshot.active ? 'blocked' : 'ready', message: killSnapshot.active ? `Kill switch active: ${killSnapshot.reason}` : 'Kill switch is clear.' },
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
        { id: 'autonomy.kill.switch', label: 'Kill switch clear', status: killSnapshot.active ? 'blocked' : 'ready', message: killSnapshot.active ? `Kill switch active: ${killSnapshot.reason}` : 'Kill switch is clear.' },
      ]),
    ];
    res.json({ generatedAt: new Date().toISOString(), workspace: PROJECT_DIR, model: currentModel, permissionMode, killSwitch: { active: killSnapshot.active, reason: killSnapshot.reason }, sandbox: sandboxSwitch.snapshot(), grants: activeGrants.length, sections, nervousSystem: { available: true, modules: ['signals', 'sensory', 'reflexes', 'attention', 'motor', 'pain', 'recovery'] } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// Jarvis 100× — unified status of the ambient/predictive/voice/inbound/MCP layer.
// See src/jarvis/ for module-by-module contracts.
const jarvisAmbientBus = new SignalBus(500);
let jarvisAmbientHandle: AmbientDaemonHandle | null = null;

app.get('/api/jarvis/status', async (_req, res) => {
  try {
    const [trust, knowledge] = await Promise.all([
      loadTrustLadder(PROJECT_DIR),
      getKnowledgeGraphStatus(PROJECT_DIR),
    ]);
    const voice = getVoiceStatus();
    const inbound = getInboundTriageStatus();
    const toolList = getRuntimeTools(PROJECT_DIR);
    const mcp = getMcpServerStatus(toolList.length);
    res.json({
      generatedAt: new Date().toISOString(),
      workspace: PROJECT_DIR,
      trustLadder: {
        capabilities: Object.values(trust.capabilities).map((c) => ({
          capability: c.capability,
          rung: c.rung,
          acceptedStreak: c.acceptedStreak,
          rejectedStreak: c.rejectedStreak,
          lastUsedAt: c.lastUsedAt,
        })),
        updatedAt: trust.updatedAt,
      },
      knowledgeGraph: knowledge,
      voice: { ...getVoiceStatus(), whisper: getWhisperHealthSnapshot() },
      inbound: getInboundTriageStatus(),
      runtime: getRuntimeRegistryStatus(),
      mcpServer: mcp,
      assistantProfile: { enabled: assistantProfileEnabled(), ambient: ambientEnabled(), proactive: proactiveProfileEnabled() },
      schedulers: schedulerRegistry.list(),
      ambient: { ready: true, running: jarvisAmbientHandle?.isRunning() ?? false, watchers: jarvisAmbientHandle?.watchersActive() ?? [], note: 'Runs by default under HARNESS_PROFILE=assistant; set HARNESS_AMBIENT_ENABLED=1/0 to force.' },
      predictive: { ready: true, note: 'Predictive engine is pure; feed it ActionEvent[] from sessions.' },
      modelCouncil: { ready: true, note: 'Council is transport-agnostic; wire to OllamaClient or OpenAIClient at the call site.' },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/jarvis/brief', async (_req, res) => {
  try {
    const [trust, knowledge, candidates, runs] = await Promise.all([
      loadTrustLadder(PROJECT_DIR),
      getKnowledgeGraphStatus(PROJECT_DIR),
      listLearningCandidates(PROJECT_DIR, 20).catch((err) => { recordSwallowed('jarvis.brief.listLearningCandidates', err); return []; }),
      readRunEvidence(PROJECT_DIR, 50).catch((err) => { recordSwallowed('jarvis.brief.readRunEvidence', err); return []; }),
    ]);
    const ambientSignals = jarvisAmbientBus.recent();
    const pendingLearningCandidates = candidates.map((c) => ({ id: c.id, prompt: c.prompt, outcome: c.outcome, createdAt: c.createdAt }));
    const events = mergeAndSort(eventsFromAmbientSignals(ambientSignals), eventsFromEvidenceCards(runs));
    const predictiveSuggestions = mineNextActions(events, { limit: 8 });
    const evidenceSummaries = runs.slice(0, 10).map((r) => ({ title: oneLineForBrief(r.request), status: r.kind, at: r.createdAt }));
    const markdown = composeDailyBrief({
      asOf: new Date().toISOString(),
      windowDescription: 'since server start',
      ambientSignals,
      pendingLearningCandidates,
      predictiveSuggestions,
      knowledgeGraph: knowledge,
      trustLadder: trust,
      evidenceSummaries,
    });
    res.json({ generatedAt: new Date().toISOString(), markdown, predictiveSuggestions });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

function oneLineForBrief(text: string, max = 80): string {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + '…';
}

app.post('/api/jarvis/trust-ladder/promote', async (req, res) => {
  try {
    const capability = String((req.body && (req.body as Record<string, unknown>).capability) ?? '').trim();
    if (!capability) { res.status(400).json({ error: 'capability is required' }); return; }
    const snap = await loadTrustLadder(PROJECT_DIR);
    ensureCapability(snap, capability);
    const result = recordOutcome(snap, capability, 'accepted');
    await saveTrustLadder(PROJECT_DIR, snap);
    res.json({ capability, rung: snap.capabilities[capability].rung, promoted: result.promoted });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/jarvis/trust-ladder/demote', async (req, res) => {
  try {
    const capability = String((req.body && (req.body as Record<string, unknown>).capability) ?? '').trim();
    if (!capability) { res.status(400).json({ error: 'capability is required' }); return; }
    const snap = await loadTrustLadder(PROJECT_DIR);
    ensureCapability(snap, capability);
    const result = recordOutcome(snap, capability, 'rejected');
    await saveTrustLadder(PROJECT_DIR, snap);
    res.json({ capability, rung: snap.capabilities[capability].rung, demoted: result.demoted });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Jarvis: top single predictive suggestion for ghost-text rendering in chat composer.
app.get('/api/jarvis/next-suggestion', async (_req, res) => {
  try {
    const runs = await readRunEvidence(PROJECT_DIR, 50).catch(() => []);
    const events = mergeAndSort(eventsFromAmbientSignals(jarvisAmbientBus.recent()), eventsFromEvidenceCards(runs));
    const suggestions = mineNextActions(events, { limit: 1 });
    res.json({ suggestion: suggestions[0] ?? null });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Jarvis: persist the daily brief into .harness/documents/.
app.post('/api/jarvis/brief/save', async (_req, res) => {
  try {
    const snap = await snapshotDailyBrief({ projectDir: PROJECT_DIR, ambientSignals: jarvisAmbientBus.recent(), windowDescription: 'snapshot' });
    const dir = path.join(PROJECT_DIR, '.harness', 'documents');
    await fs.mkdir(dir, { recursive: true });
    const filename = `jarvis-brief-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, snap.markdown, 'utf-8');
    res.json({ savedTo: path.relative(PROJECT_DIR, filePath), generatedAt: snap.generatedAt });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Jarvis: send the daily brief to Telegram chats already known to the bot.
// Closes the loop so a user with the Telegram bot configured gets a proactive
// summary they can read on their phone without opening the harness.
app.post('/api/jarvis/brief/telegram', async (_req, res) => {
  try {
    const snap = await snapshotDailyBrief({ projectDir: PROJECT_DIR, ambientSignals: jarvisAmbientBus.recent(), windowDescription: 'snapshot' });
    // Telegram caps text length around 4096 chars per message; trim the body
    // and append a marker so the recipient knows there's more in the UI.
    const TELEGRAM_BODY_CAP = 3800;
    const body = snap.markdown.length <= TELEGRAM_BODY_CAP
      ? snap.markdown
      : snap.markdown.slice(0, TELEGRAM_BODY_CAP) + '\n\n…(truncated — open Mission Control for the full brief)';
    const sent = await sendTelegramNotification('Daily Brief', body);
    if (sent === 0) {
      res.status(409).json({ error: 'No Telegram recipients available. Configure HARNESS_TELEGRAM_BOT_TOKEN and have someone send /start to the bot first.' });
      return;
    }
    res.json({ delivered: sent, generatedAt: snap.generatedAt });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Jarvis: ambient daemon control (start/stop without server restart).
app.get('/api/jarvis/ambient', (_req, res) => {
  res.json({
    running: jarvisAmbientHandle?.isRunning() ?? false,
    watchers: jarvisAmbientHandle?.watchersActive() ?? [],
    recentSignalCount: jarvisAmbientBus.recent().length,
  });
});

app.post('/api/jarvis/ambient/start', (_req, res) => {
  try {
    if (jarvisAmbientHandle?.isRunning()) {
      res.json({ running: true, watchers: jarvisAmbientHandle.watchersActive(), note: 'already running' });
      return;
    }
    jarvisAmbientHandle = startAmbientDaemon(jarvisAmbientBus, {
      watchDir: PROJECT_DIR,
      fileFilters: ['IMPLEMENTATION_PLAN.md', 'src/', 'cookbook/', '.harness/'],
      gitPollMs: Number(process.env.HARNESS_AMBIENT_GIT_POLL_MS ?? '15000') || 15000,
      schedulerMs: Number(process.env.HARNESS_AMBIENT_SCHEDULER_MS ?? '0') || 0,
      projectDir: PROJECT_DIR,
    });
    schedulerRegistry.register({
      name: 'jarvis-ambient',
      stop: () => { jarvisAmbientHandle?.stop(); },
      isRunning: () => jarvisAmbientHandle?.isRunning() ?? false,
    });
    res.json({ running: true, watchers: jarvisAmbientHandle.watchersActive() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/jarvis/ambient/stop', (_req, res) => {
  try {
    if (jarvisAmbientHandle?.isRunning()) jarvisAmbientHandle.stop();
    jarvisAmbientHandle = null;
    schedulerRegistry.unregister('jarvis-ambient');
    res.json({ running: false });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Stop a single registered scheduler by name. Surfaces the SchedulerRegistry's
// per-entry stop control in the Jarvis Live panel so an operator can halt one
// noisy subsystem without the global kill switch (which only no-ops ticks) or a
// full server restart. Stopping is reversible by restarting the server or, for
// schedulers with their own toggle (ambient, curator), re-enabling them there.
app.post('/api/jarvis/schedulers/:name/stop', async (req, res) => {
  try {
    const name = String(req.params.name ?? '');
    if (!schedulerRegistry.list().some((entry) => entry.name === name)) {
      res.status(404).json({ error: `Unknown scheduler: ${name}` });
      return;
    }
    const result = await schedulerRegistry.stop(name);
    res.json({ ok: result?.ok !== false, result, schedulers: schedulerRegistry.list() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Restart a single registered scheduler by name. Complements the stop control
// so an operator can bring a scheduler back without a full server restart.
// Only schedulers that expose a restart() hook (the ones backed by an
// idempotent configureX()) are restartable; the rest return 409.
app.post('/api/jarvis/schedulers/:name/restart', async (req, res) => {
  try {
    const name = String(req.params.name ?? '');
    if (!schedulerRegistry.list().some((entry) => entry.name === name)) {
      res.status(404).json({ error: `Unknown scheduler: ${name}` });
      return;
    }
    const result = await schedulerRegistry.restart(name);
    if (result && result.ok === false) {
      res.status(409).json({ error: result.error ?? `Scheduler ${name} is not restartable`, schedulers: schedulerRegistry.list() });
      return;
    }
    res.json({ ok: true, result, schedulers: schedulerRegistry.list() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const VALID_RUNTIME_FEATURES = new Set<RuntimeFeature>(['voice_stt', 'voice_tts', 'voice_wake', 'inbound_slack', 'inbound_telegram', 'inbound_email']);

app.post('/api/jarvis/runtime/register', (req, res) => {
  try {
    const feature = String((req.body as Record<string, unknown>)?.feature ?? '') as RuntimeFeature;
    const adapterName = String((req.body as Record<string, unknown>)?.adapterName ?? '').trim();
    if (!VALID_RUNTIME_FEATURES.has(feature)) { res.status(400).json({ error: `feature must be one of ${[...VALID_RUNTIME_FEATURES].join(', ')}` }); return; }
    if (!adapterName) { res.status(400).json({ error: 'adapterName is required' }); return; }
    markRuntimeInstalled(feature, adapterName);
    void saveRuntimeRegistry(PROJECT_DIR).catch((err) => recordSwallowed('saveRuntimeRegistry', err));
    res.json({ feature, adapterName, status: getRuntimeRegistryStatus() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/jarvis/runtime/clear', (_req, res) => {
  clearRuntimeRegistry();
  void saveRuntimeRegistry(PROJECT_DIR).catch((err) => recordSwallowed('saveRuntimeRegistry', err));
  res.json({ status: getRuntimeRegistryStatus() });
});

// Jarvis: offline speech-to-text via whisper.cpp.
// Accepts a raw 16kHz mono WAV body and returns the transcribed text.
// Two configuration paths:
//   1. Native whisper.cpp:  HARNESS_WHISPER_BINARY + HARNESS_WHISPER_MODEL
//   2. Python pywhispercpp: HARNESS_WHISPER_PYTHON (e.g. "python") +
//      optional HARNESS_WHISPER_MODEL_NAME (default base.en)
// Returns 503 when neither is configured so the UI can fall back gracefully.

// Probe whisper config without touching the request/response cycle. Used
// both by GET /api/jarvis/voice/health and by /api/jarvis/status so the
// runtime panel can surface mode + hint without a second round-trip.
//
// Falls back to autoDetectedWhisper (populated at startup by
// detectWhisperFallback) when no env vars are set, so out-of-the-box
// installs work without manual configuration.
function getWhisperHealthSnapshot(): { ok: boolean; mode: 'binary' | 'python' | 'none'; hint: string; source?: 'env' | 'auto-detect' } {
  const binary = process.env.HARNESS_WHISPER_BINARY;
  const model = process.env.HARNESS_WHISPER_MODEL;
  const pythonExe = process.env.HARNESS_WHISPER_PYTHON;
  if (binary && model) {
    return { ok: true, mode: 'binary', hint: `whisper.cpp binary at ${binary}`, source: 'env' };
  }
  if (pythonExe) {
    const modelName = process.env.HARNESS_WHISPER_MODEL_NAME || 'base.en (default)';
    return { ok: true, mode: 'python', hint: `pywhispercpp via ${pythonExe} · model ${modelName}`, source: 'env' };
  }
  if (autoDetectedWhisper) {
    return {
      ok: true,
      mode: 'python',
      hint: `auto-detected: pywhispercpp via ${autoDetectedWhisper.python} · model ${autoDetectedWhisper.modelName}`,
      source: 'auto-detect',
    };
  }
  return {
    ok: false,
    mode: 'none',
    hint: 'Set HARNESS_WHISPER_BINARY+HARNESS_WHISPER_MODEL or HARNESS_WHISPER_PYTHON (+ optional HARNESS_WHISPER_MODEL_NAME). Auto-detect found nothing in well-known locations.',
  };
}

// Auto-detect populated at startup. Holds the first viable
// python+model combo found in well-known locations so users get
// hands-free voice without setting any env vars manually.
let autoDetectedWhisper: { python: string; modelName: string } | null = null;

async function detectWhisperFallback(): Promise<void> {
  // Skip detection when env vars are explicitly set — user opt-in wins.
  if (process.env.HARNESS_WHISPER_BINARY || process.env.HARNESS_WHISPER_PYTHON) return;
  const home = os.homedir();
  // Conservative scan: model files only, in well-known places. Don't walk
  // the disk — we want startup to stay fast.
  const modelCandidates = [
    path.join(home, 'whisper-models'),
    path.join(home, '.cache', 'whisper'),
    path.join(PROJECT_DIR, 'models', 'whisper'),
  ];
  let modelName: string | null = null;
  for (const dir of modelCandidates) {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    // Prefer larger / English models when multiple are present.
    const prefer = ['ggml-medium.en.bin', 'ggml-small.en.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin'];
    for (const name of prefer) {
      if (entries.includes(name)) { modelName = path.join(dir, name); break; }
    }
    if (modelName) break;
    // Fallback: any ggml-*.bin
    const any = entries.find((e) => e.startsWith('ggml-') && e.endsWith('.bin'));
    if (any) { modelName = path.join(dir, any); break; }
  }
  if (!modelName) return;
  // Probe `python -c 'import pywhispercpp'` once. 5s timeout so a hung
  // python install can't wedge the whole server boot.
  const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn(pythonExe, ['-c', 'import pywhispercpp'], { windowsHide: true });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 5000);
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  if (!ok) return;
  autoDetectedWhisper = { python: pythonExe, modelName };
  logger.info('Startup', `Whisper auto-detect: ${pythonExe} + ${modelName}`);
}

// Per-IP token bucket on the transcribe route. The route spawns a python
// subprocess and reads up to 50MB of audio per call — a stuck hands-free
// tab could fork-bomb whisper without this. 6 calls/min sustained, with
// burst of 6.
const whisperRateLimiter = new RateLimiter(6, 0.1);

app.get('/api/jarvis/voice/health', (_req, res) => {
  res.json(getWhisperHealthSnapshot());
});

app.post('/api/jarvis/voice/transcribe', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  if (!whisperRateLimiter.tryConsume()) {
    res.status(429).json({
      error: 'Too many transcribe requests — 6/min sustained limit hit.',
      hint: 'A stuck hands-free tab can flood this endpoint. Stop hands-free mode and retry in a minute.',
    });
    return;
  }
  const binary = process.env.HARNESS_WHISPER_BINARY;
  const model = process.env.HARNESS_WHISPER_MODEL;
  const pythonExe = process.env.HARNESS_WHISPER_PYTHON || (autoDetectedWhisper ? autoDetectedWhisper.python : undefined);
  const usePython = !binary && !!pythonExe;
  if (!usePython && (!binary || !model)) {
    res.status(503).json({
      error: 'Whisper not configured.',
      hint: 'Either set HARNESS_WHISPER_BINARY + HARNESS_WHISPER_MODEL (native whisper.cpp), or set HARNESS_WHISPER_PYTHON=python (after pip install pywhispercpp). Auto-detect found nothing.',
    });
    return;
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'Empty audio body. POST a 16kHz mono WAV.' });
    return;
  }
  const tmpDir = path.join(PROJECT_DIR, '.harness', 'jarvis', 'whisper-tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const wavPath = path.join(tmpDir, `stt-${id}.wav`);
  try {
    await fs.writeFile(wavPath, req.body);
    let cmd: string;
    let args: string[];
    if (usePython) {
      cmd = pythonExe!;
      args = [resolveJarvisWhisperBridgePath(), wavPath];
    } else {
      cmd = binary!;
      args = ['-m', model!, '-f', wavPath, '--no-timestamps', '--no-prints'];
    }
    const text = await new Promise<string>((resolve, reject) => {
      // When auto-detect supplied the python path, also inject the model
      // name into the spawned process env so jarvis_whisper.py picks it up
      // without the user setting HARNESS_WHISPER_MODEL_NAME explicitly.
      const childEnv = { ...process.env };
      if (usePython && !process.env.HARNESS_WHISPER_MODEL_NAME && autoDetectedWhisper) {
        childEnv.HARNESS_WHISPER_MODEL_NAME = autoDetectedWhisper.modelName;
      }
      const proc = spawn(cmd, args, { windowsHide: true, env: childEnv });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', (err) => reject(new Error(`Whisper spawn failed: ${err.message}`)));
      proc.on('close', (code: number | null) => {
        if (code !== 0) reject(new Error(`Whisper exited ${code}: ${stderr.trim().slice(0, 240)}`));
        else resolve(stdout.trim());
      });
    });
    res.json({ text, durationMs: 0 });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    fs.unlink(wavPath).catch(() => undefined);
  }
});

// Jarvis: ad-hoc council dispatch — vote / debate / arbiter modes against
// any list of installed Ollama models. The arbiter must be supplied for
// non-vote modes. Returns the chosen answer plus the per-member responses.
app.post('/api/jarvis/council/run', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = String(body.prompt ?? '').trim();
    const mode = String(body.mode ?? 'vote') as 'vote' | 'debate' | 'arbiter';
    const arbiter = typeof body.arbiter === 'string' ? body.arbiter : undefined;
    const memberInput = Array.isArray(body.members) ? (body.members as Array<{ model: string; weight?: number }>) : [];
    if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }
    if (memberInput.length === 0) { res.status(400).json({ error: 'members array is required' }); return; }
    if (mode !== 'vote' && !arbiter) { res.status(400).json({ error: `mode "${mode}" requires an arbiter model` }); return; }
    const result = await runCouncilForChat(prompt, {
      mode,
      members: memberInput,
      arbiter,
      perMemberTimeoutMs: 60_000,
    }, (model: string) => new OllamaClient({ model, host: ollamaHost }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/jarvis/graph/mermaid', async (req, res) => {
  try {
    const records = await readKnowledgeGraph(PROJECT_DIR);
    const focus = typeof req.query.focus === 'string' ? req.query.focus : undefined;
    const mermaid = composeMermaidGraph(records, focus ? { focus } : {});
    res.json({ mermaid });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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
    configured: Boolean(connectorSecretValue('HARNESS_DISCORD_BOT_TOKEN')),
  });
});

app.post('/api/discord/token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const channelIds = typeof req.body?.channelIds === 'string' ? req.body.channelIds.trim() : '';
  if (!token) { res.status(400).json({ error: 'Discord bot token is required.' }); return; }
  stopDiscordBot();
  await storeConnectorSecret('HARNESS_DISCORD_BOT_TOKEN', token.slice(0, 200));
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

app.get('/api/slack/status', (_req, res) => {
  res.json(getSlackConnectorStatus(connectorSecretValue('HARNESS_SLACK_WEBHOOK_URL')));
});

app.post('/api/slack/webhook', async (req, res) => {
  await storeConnectorSecret('HARNESS_SLACK_WEBHOOK_URL', sanitizeSlackWebhookUrl(req.body?.webhookUrl));
  await saveSettingsToDisk();
  res.json({ ok: true, status: getSlackConnectorStatus(connectorSecretValue('HARNESS_SLACK_WEBHOOK_URL')) });
});

app.get('/api/whatsapp/status', (_req, res) => {
  res.json(getWhatsAppConnectorStatus({ accessToken: connectorSecretValue('HARNESS_WHATSAPP_ACCESS_TOKEN'), phoneNumberId: whatsappPhoneNumberId || process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID, allowedRecipients: whatsappAllowedRecipients || process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS }));
});

app.post('/api/whatsapp/setup', async (req, res) => {
  const sanitized = sanitizeWhatsAppSetup({ accessToken: req.body?.accessToken, phoneNumberId: req.body?.phoneNumberId, allowedRecipients: req.body?.allowedRecipients });
  await storeConnectorSecret('HARNESS_WHATSAPP_ACCESS_TOKEN', sanitized.accessToken);
  whatsappPhoneNumberId = sanitized.phoneNumberId;
  whatsappAllowedRecipients = sanitized.allowedRecipients;
  if (whatsappPhoneNumberId) process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID = whatsappPhoneNumberId;
  else delete process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID;
  if (whatsappAllowedRecipients) process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS = whatsappAllowedRecipients;
  else delete process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS;
  await saveSettingsToDisk();
  res.json({ ok: true, status: getWhatsAppConnectorStatus({ accessToken: connectorSecretValue('HARNESS_WHATSAPP_ACCESS_TOKEN'), phoneNumberId: whatsappPhoneNumberId, allowedRecipients: whatsappAllowedRecipients }) });
});

// ─── Connector status / contracts / ingress policy ───────────────────────
// 3 read-only routes (GET /api/connectors/status, GET /api/connectors/contracts,
// GET /api/message-ingress/policy) extracted to ./connectorRoutes.ts. The
// status route reads server.ts mutable connector module state (telegram/
// discord/whatsapp tokens + bot running flags); we pass it as a single
// callable so the router stays decoupled. Contracts + ingress policy use
// only services/capabilityTemplateStarters and were dropped from server.ts
// import entirely (4 symbols).
app.use(createConnectorRouter({
  getConnectorStatusSnapshot: () => {
    const smtpHost = process.env.HARNESS_SMTP_HOST?.trim();
    const smtpUser = process.env.HARNESS_SMTP_USER?.trim();
    const smtpPass = process.env.HARNESS_SMTP_PASS?.trim();
    return {
      telegram: { connector: 'telegram', configured: Boolean(telegramBotToken), running: isTelegramBotRunning(), hasAllowedChatIds: Boolean(telegramAllowedChatIds), mode: 'chat-bridge' },
      discord: { connector: 'discord', configured: Boolean(connectorSecretValue('HARNESS_DISCORD_BOT_TOKEN')), running: isDiscordBotRunning(), hasAllowedChannelIds: Boolean(discordAllowedChannelIds), mode: 'chat-bridge' },
      slack: getSlackConnectorStatus(connectorSecretValue('HARNESS_SLACK_WEBHOOK_URL')),
      whatsapp: getWhatsAppConnectorStatus({ accessToken: connectorSecretValue('HARNESS_WHATSAPP_ACCESS_TOKEN'), phoneNumberId: whatsappPhoneNumberId || process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID, allowedRecipients: whatsappAllowedRecipients || process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS }),
      smtp: { connector: 'smtp', configured: Boolean(smtpHost && smtpUser && smtpPass), mode: 'outbound' },
    };
  },
}));
app.get('/api/capability-templates', async (_req, res) => {
  try {
    await ensureSettingsLoaded();
    const registry = createDefaultCapabilityRegistry();
    const telegramReady = Boolean(telegramBotToken && isTelegramBotRunning() && telegramAllowedChatIds);
    const discordReady = Boolean(connectorSecretValue('HARNESS_DISCORD_BOT_TOKEN') && isDiscordBotRunning() && discordAllowedChannelIds);
    const slackStatus = getSlackConnectorStatus(connectorSecretValue('HARNESS_SLACK_WEBHOOK_URL'));
    const whatsAppStatus = getWhatsAppConnectorStatus({ accessToken: connectorSecretValue('HARNESS_WHATSAPP_ACCESS_TOKEN'), phoneNumberId: whatsappPhoneNumberId || process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID, allowedRecipients: whatsappAllowedRecipients || process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS });
    const ragIndexes = await ragIndex.listIndexes(PROJECT_DIR).catch(() => []);
    const anyNotificationReady = telegramReady || discordReady || Boolean(slackStatus.configured) || Boolean(whatsAppStatus.configured && whatsAppStatus.hasAllowedRecipients);
    const cloudConfigured = Object.values(OPENAI_COMPATIBLE_PRESETS).some((preset) => Boolean(readApiKey(preset)));
    if (anyNotificationReady) registry.register('notifications', 'Push notifications', 'available');
    if (telegramReady) registry.register('telegram', 'Telegram messaging', 'available');
    if (ragIndexes.length > 0) registry.register('vector_memory', 'Vector/semantic memory', 'available');
    if (cloudConfigured) registry.register('cloud_models', 'Cloud LLM backends', 'available');
    if (process.env.HARNESS_SMTP_HOST && process.env.HARNESS_SMTP_USER && process.env.HARNESS_SMTP_PASS) registry.register('email', 'Email sending', 'available');

    const connectors: Record<string, ConnectorReadinessInput> = {
      telegram: { connector: 'telegram', configured: Boolean(telegramBotToken), running: isTelegramBotRunning(), hasAllowedChatIds: Boolean(telegramAllowedChatIds), mode: 'chat-bridge' },
      discord: { connector: 'discord', configured: Boolean(connectorSecretValue('HARNESS_DISCORD_BOT_TOKEN')), running: isDiscordBotRunning(), hasAllowedChannelIds: Boolean(discordAllowedChannelIds), mode: 'chat-bridge' },
      slack: { connector: 'slack', configured: Boolean(slackStatus.configured), mode: slackStatus.mode },
      whatsapp: { connector: 'whatsapp', configured: Boolean(whatsAppStatus.configured), hasAllowedRecipients: Boolean(whatsAppStatus.hasAllowedRecipients), mode: whatsAppStatus.mode },
    };
    const starters = listCapabilityTemplateStarters();
    const templates = evaluateCapabilityTemplates(registry, connectors).map((template) => ({
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

app.get('/api/capability-templates/starters', (_req, res) => {
  try {
    res.json({ starters: listCapabilityTemplateStarters() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/capability-templates/:id/starter', (req, res) => {
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

app.post('/api/capability-templates/:id/actions', async (req, res) => {
  try {
    await ensureSettingsLoaded();
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
      const document = await createGeneratedDocument({
        title: starter.title,
        template: normalizeDocumentTemplate(starter.document.template),
        format: normalizeDocumentFormat(starter.document.format),
        sourceLabel: starter.document.sourceLabel,
        content: starter.document.content,
      });
      res.json({ ok: true, action, kind: starter.kind, starter, document: document.metadata, content: document.content });
      return;
    }
    if (starter.kind === 'automation') {
      if (!starter.automationJob) { res.status(400).json({ error: 'Starter has no automation payload.' }); return; }
      const job = await createAutomationJob(PROJECT_DIR, {
        name: starter.automationJob.name,
        prompt: starter.automationJob.prompt,
        schedule: starter.automationJob.schedule,
        scriptCommand: starter.automationJob.scriptCommand,
      });
      logger.info('CapabilityTemplates', 'Starter automation job created', { templateId, jobId: job.id, name: job.name });
      res.json({ ok: true, action, kind: starter.kind, starter, job });
      return;
    }
    res.status(400).json({ error: `Unsupported starter kind: ${starter.kind}` });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// ─── Static asset serving (desktop input evidence, research reports) ─
// 3 file-serving routes (GET /api/desktop-input/evidence + /file/:name,
// GET /api/research/report/:name) extracted to ./assetRoutes.ts. All
// sendFile-based with dotfiles:'allow' for .harness/ paths; no module
// state coupling.
app.use(createAssetRouter({ projectDir: PROJECT_DIR }));

// 3 webhook routes (GET /api/webhooks, POST /api/webhooks, DELETE
// /api/webhooks/:id) extracted to ./webhookRoutes.ts. server.ts keeps
// loadWebhooksFromEnv + sendWebhookNotification (non-HTTP boot/notify paths).
app.use(createWebhookRouter());

// Governed Agent Loop working-memory surface: GET /api/working-memory returns
// the latest session's most recent continuity checkpoint as a unified
// WorkingMemory object (read-only).
app.use(createWorkingMemoryRouter({ projectDir: PROJECT_DIR }));

// Governed Agent Loop review queue: human-gated list/approve/reject/drain for
// staged brain-updates and needs-review answers (GET /api/review-queue,
// POST /api/review-queue/:id/{approve,reject,drain}).
app.use(createReviewQueueRouter());

// Browser hardening surface: GET /api/browser/audit (page-action audit log),
// GET/POST/DELETE /api/browser/sessions (cookie/session vault). Redaction
// settings flow through POST /api/settings (browserRedaction).
app.use(createBrowserHardeningRouter());

// Replay execution: consume the drained needs-review answers and re-ask each
// one through the harness, re-enqueuing the fresh governed answer for review.
// This closes the loop (drain -> replay -> re-review) and auto-approves
// nothing. With governance off it is a no-op (runReplayQuery yields null).
app.post('/api/replay-candidates/run', async (_req, res) => {
  try {
    const result = await runReplayCandidates({ runOne: runReplayQuery });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Nervous-system snapshot API ─────────────────────────────────────
// /api/nervous (live snapshot of last chat-handler controller) + /api/nervous/
// history (persisted signal log). Extracted to ./nervousRoutes.ts. server.ts
// still owns the lastNervousSnapshot module-level cache + shouldBypassNervousVerification
// (3 non-HTTP callers in the tool-call loop); router takes callable deps so it
// sees mutable state at request time.
app.use(createNervousRouter({
  projectDir: PROJECT_DIR,
  getLastSnapshot: () => lastNervousSnapshot,
  getPermissionMode: () => permissionMode,
  isVerificationBypassActive: () => shouldBypassNervousVerification(),
  readPersistedSignals: (projectDir, limit) => NervousSystemController.readPersistedSignals(projectDir, limit),
}));

app.get('/api/discovery', async (_req, res) => {
  await ensureSettingsLoaded();
  // Refresh capability registry with current server state
  refreshCapabilityRegistry();
  try {
    const automationPolicy = getAutomationPolicyContext();
    const ttlMs = modelCatalog.ttlHours * 60 * 60 * 1000;
    const [catalog, catalogStatus, extensions, automationJobs, dueAutomations, agenticServices, sessionSearch, runtimeSkills, repoSkills, globalSkills, curatorLog] = await Promise.all([
      getModelCatalog(PROJECT_DIR, { url: modelCatalog.url || undefined, ttlMs, fetchJson: fetchJsonFromUrl }),
      getModelCatalogCacheStatus(PROJECT_DIR, new Date(), ttlMs),
      discoverExtensionManifests(PROJECT_DIR),
      listAutomationJobs(PROJECT_DIR),
      listDueAutomationJobs(PROJECT_DIR),
      listAgenticServices(PROJECT_DIR),
      getSessionSearchIndexStatus(PROJECT_DIR),
      scanSkillsDir(SKILLS_DIR),
      scanSkillsDir(REPO_SKILLS_DIR),
      scanSkillsDir(GLOBAL_SKILLS_DIR),
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
          global: { directory: GLOBAL_SKILLS_DIR, total: globalSkills.skills.length, diagnosticCount: globalSkills.diagnostics.length, diagnostics: globalSkills.diagnostics },
          sources: [
            skillSourceForApi('runtime', 'Runtime skills', SKILLS_DIR, runtimeSkills, true),
            skillSourceForApi('repo', 'Repo skills', REPO_SKILLS_DIR, repoSkills, false),
            skillSourceForApi('global', 'Global skills', GLOBAL_SKILLS_DIR, globalSkills, false),
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
// Misc small routes (worker queue, mode classifier, swallowed-failure
// diagnostics) extracted to ./miscRoutes.ts. classifyMode is still
// imported by server.ts (chat handler ~5417 + agent routes ~2493).
app.use(createMiscRouter());

// ─── Agentic services + lifecycle + templates + health ──────────────
// All /api/services/* routes extracted to ./serviceRoutes.ts. server.ts
// still imports listAgenticServices (system-overview + system-health),
// keeps recordOperatingServiceEvidence + operatingServiceLifecycleAudit
// here because they read server.ts module state (currentModel,
// permissionMode, capabilityGrants).
app.use(createServiceRouter({
  projectDir: PROJECT_DIR,
  getOperatingServiceLifecycleAudit: () => operatingServiceLifecycleAudit(),
  recordOperatingServiceEvidence,
}));

// ─── Tasks + Kanban ─────────────────────────────────────────────────
// Structured task lifecycle and the Kanban board over them. Routes
// extracted to ./taskRoutes.ts so server.ts holds wiring, not handlers.
const runCodexTaskWithConductor: CodexTaskRunner = async ({ task, contract, prompt, onEvent, abortSignal }) => {
  await ensureSettingsLoaded();
  const requestedModel = currentModel || 'llama3.1:8b';
  const routed = await resolveChatModelForRequest(requestedModel, prompt);
  const activeModel = routed.model;
  onEvent({ type: 'model', model: activeModel });

  const activeContextMaxTokens = await resolveContextMaxTokens(activeModel);
  const client = webRuntime.createClient(activeModel, ollamaHost, activeContextMaxTokens);
  const tools = webRuntime.getTools();
  const permissions = webRuntime.createPermissionEngine(permissionMode);
  const session = webRuntime.createSession(PROJECT_DIR, activeModel);
  await session.initialize();
  const learningRecorder = new LearningRecorder(PROJECT_DIR);
  const systemPrompt = await webRuntime.assembleSystemContext({
    systemPrompt: [
      'You are running Codex Task Mode for a single tracked coding task.',
      'Work against the task contract. Keep changes scoped. Validate before declaring completion.',
      'Report concise progress at the end of each step.',
    ].join('\n'),
    projectDir: PROJECT_DIR,
    skillsDir: SKILLS_DIR,
    recallProjectDir: PROJECT_DIR,
    recallQuery: prompt.slice(0, 240),
    ragProjectDir: PROJECT_DIR,
    ragQuery: prompt.slice(0, 240),
    ragOllamaHost: ollamaHost,
    palaceProjectDir: PROJECT_DIR,
    sessionSearchProjectDir: PROJECT_DIR,
    sessionSearchQuery: prompt.slice(0, 240),
    ccmemUrl: ccmemUrl || undefined,
    ccmemQuery: prompt.slice(0, 240),
  });

  const config: LoopConfig = {
    model: activeModel,
    systemPrompt,
    maxTurns: contract.max_turns,
    taskContract: contract,
    verify: { enabled: true, quick: true, timeout: 60_000 },
    validateToolInput: true,
    readBeforeWrite: { mode: 'warn', allowNewFiles: true },
    repeatedToolFailureLimit: 3,
    unproductiveTurnLimit: 5,
    context: { enabled: true, maxTokens: activeContextMaxTokens, summarizerModel: summarizerModel || undefined },
    outputValidation: { enabled: true, profile: 'coding-answer', customProfiles: customOutputValidationProfiles },
    autoContinue: true,
    taskType: contract.intent_type,
    abortSignal,
  };
  const deps: QueryLoopDeps = {
    client,
    tools,
    permissionCheck: async (call) => {
      const result = permissions.evaluate(call);
      if (result.decision === 'allow') return { allowed: true, reason: result.reason };
      if (result.decision === 'deny') return { allowed: false, reason: result.reason };
      return permissionPrompts.request(call, result.reason);
    },
    hooks: hookPipeline,
    session,
    summarizerClient: summarizerModel ? webRuntime.createClient(summarizerModel, ollamaHost, activeContextMaxTokens) : undefined,
    tracer: runtimeTracer,
    learningRecorder,
    adversaryJudge: createLlmAdversaryJudge(client),
  };

  const outcome = await runConductor({
    task: prompt,
    planner: createLlmPlanner(client),
    executor: createQueryLoopExecutor(config, deps, {
      onLoopEvent: (event) => onEvent({ type: 'loop_event', event }),
    }),
    verifier: createCodeVerifier(PROJECT_DIR, { quick: true, timeout: 60_000 }),
    persistDir: path.join(PROJECT_DIR, '.harness', 'conductor'),
    runId: task.id,
    abortSignal,
    onEvent: (event) => onEvent(toCodexRunnerEvent(event)),
  });

  return {
    status: outcome.status,
    assistantText: outcome.assistantText,
    toolCallCount: outcome.toolCallCount,
    toolSuccessCount: outcome.toolSuccessCount,
    verifications: outcome.verifications,
    capabilityGaps: outcome.capabilityGaps,
  };
};

function toCodexRunnerEvent(event: ConductorEvent): CodexTaskRunnerEvent {
  switch (event.type) {
    case 'plan': return { type: 'plan', plan: event.plan };
    case 'step_start': return { type: 'step_start', step: event.step, index: event.index, total: event.total };
    case 'step_result': return { type: 'step_result', step: event.step, result: event.result };
    case 'verify': return { type: 'verify', step: event.step, result: event.result };
    case 'remediation': return { type: 'remediation', failedStep: event.failedStep, attempt: event.attempt };
    case 'capability_gap': return { type: 'capability_gap', gap: event.gap };
    case 'done': return { type: 'done', status: event.status, steps: event.steps };
  }
}

app.use(createTaskRoutesRouter({ projectDir: PROJECT_DIR, runCodexTask: runCodexTaskWithConductor }));

// ─── Triggers ───────────────────────────────────────────────────────
// Persisted in .harness/triggers/triggers.json. Routes extracted to
// ./triggerRoutes.ts. server.ts still owns the TriggerScheduler instance
// (configureTriggerScheduler / triggersEnabled) — the router just calls
// back via the isEnabled + invalidateScheduler deps.
app.use(createTriggerRouter({
  projectDir: PROJECT_DIR,
  isEnabled: () => triggersEnabled(),
  invalidateScheduler: () => triggerScheduler ? triggerScheduler.invalidate() : Promise.resolve(),
}));

// ─── Artifacts catalog ───────────────────────────────────
// Read-only cross-session view of agent-outputs/ (honours
// HARNESS_AGENT_OUTPUT_DIR). Routes extracted to ./artifactRoutes.ts.
app.use(createArtifactRouter({ projectDir: PROJECT_DIR }));

// ─── Active sub-agents ─────────────────────────────────
// Routes extracted to ./subagentRoutes.ts. The WS bridge below
// (subscribeSubagentRegistry) still lives here because it wires
// the in-process registry onto the event store.
app.use(createSubagentRouter({
  projectDir: PROJECT_DIR,
  getAgentOutputDirOverride: () => agentOutputDir,
}));

// ─── Sessions, recovery, forking, import/export ───────
// All /api/sessions/* routes extracted to ./sessionRoutes.ts.
// Router takes a getCurrentModel callable so resume/fork/import
// continue to see server.ts's live `currentModel` selection.
app.use(createSessionRouter({
  projectDir: PROJECT_DIR,
  getCurrentModel: () => currentModel || '',
}));

// ─── Memory (semantic + curated) ──────────────────────
// All /api/memory/* routes extracted to ./memoryRoutes.ts. server.ts
// still imports rebuildSemanticMemory + searchSemanticMemory directly
// for the chat handler + webRuntime registry hooks.
app.use(createMemoryRouter({ projectDir: PROJECT_DIR }));

// Bridge registry mutations onto the event store so live WebSocket
// clients can react to start / end / cancel without polling. Server
// startup wires this once; the unsubscribe handle is stored on the
// module so a restart would clean it up if we ever needed to.
let _subagentRegistryUnsubscribe: (() => void) | null = null;
function wireSubagentRegistryBridge(): void {
  if (_subagentRegistryUnsubscribe) return;
  _subagentRegistryUnsubscribe = subscribeSubagentRegistry((event) => {
    if (event.kind === 'start') {
      emitEvent(PROJECT_DIR, 'system', 'subagent.start', { id: event.record.id, name: event.record.name, promptSnippet: event.record.promptSnippet, startedAtMs: event.record.startedAtMs }, 'subagent', event.record.id).catch((err) => recordSwallowed('emitEvent', err));
    } else if (event.kind === 'end') {
      emitEvent(PROJECT_DIR, 'system', 'subagent.end', { id: event.id }, 'subagent', event.id).catch((err) => recordSwallowed('emitEvent', err));
    } else if (event.kind === 'cancel') {
      emitEvent(PROJECT_DIR, 'system', 'subagent.cancel', { id: event.id }, 'subagent', event.id).catch((err) => recordSwallowed('emitEvent', err));
    }
  });
}
wireSubagentRegistryBridge();

// ─── Tool failure alerts ───────────────────────────────────────────
// Sliding window per tool. When the failure rate exceeds the configured
// threshold over a recent window, we fire a single tool.failure_alert
// event onto the event store so live WS clients (and audit dashboards)
// can react. Cooldown prevents alert storms.
const toolFailureAlerts: ToolFailureAlertTracker = createToolFailureAlerts({
  windowSize: Number(process.env.HARNESS_TOOL_ALERT_WINDOW ?? '50') || 50,
  minSamples: Number(process.env.HARNESS_TOOL_ALERT_MIN_SAMPLES ?? '10') || 10,
  failureThreshold: Number(process.env.HARNESS_TOOL_ALERT_THRESHOLD ?? '0.30') || 0.30,
  cooldownMs: Number(process.env.HARNESS_TOOL_ALERT_COOLDOWN_MS ?? `${5 * 60 * 1000}`) || 5 * 60 * 1000,
});
toolFailureAlerts.subscribe((alert) => {
  emitEvent(PROJECT_DIR, 'tool', 'tool.failure_alert', {
    tool: alert.tool,
    failure_rate: alert.failureRate,
    failure_count: alert.failureCount,
    total_count: alert.totalCount,
    threshold: alert.threshold,
    fired_at: alert.firedAt,
  }, 'system', alert.tool).catch((err) => recordSwallowed('server.ts:3659', err));
});

// ─── Prometheus /metrics ───────────────────────────────────────────
// Exposition-format snapshot of liveness + tool stats. No new deps.
app.get('/metrics', (_req, res) => {
  try {
    const subagents = listActiveSubagents();
    const heartbeatAgeMs = heartbeatLastRunMs ? Date.now() - heartbeatLastRunMs : 0;
    const alertStatus = toolFailureAlerts.status();
    const toolSampleSamples = Object.entries(alertStatus).flatMap(([tool, snap]) => [
      { value: snap.samples, labels: { tool } },
    ]);
    const toolFailureSamples = Object.entries(alertStatus).flatMap(([tool, snap]) => [
      { value: snap.failureRate, labels: { tool } },
    ]);
    const metrics: PrometheusMetric[] = [
      {
        name: 'harness_kill_switch_active',
        help: 'Whether the global kill switch is engaged (0 or 1)',
        type: 'gauge',
        samples: [{ value: killSwitchActive ? 1 : 0 }],
      },
      {
        name: 'harness_active_subagents',
        help: 'Number of currently running sub-agents',
        type: 'gauge',
        samples: [{ value: subagents.length }],
      },
      {
        name: 'harness_capability_grants_active',
        help: 'Number of currently active capability grants',
        type: 'gauge',
        samples: [{ value: listActiveCapabilityGrants(capabilityGrants).length }],
      },
      {
        name: 'harness_heartbeat_age_seconds',
        help: 'Seconds since the last heartbeat tick (0 if never)',
        type: 'gauge',
        samples: [{ value: Math.floor(heartbeatAgeMs / 1000) }],
      },
      {
        name: 'harness_otel_export_queued',
        help: 'Currently queued spans/events in the OTLP exporter',
        type: 'gauge',
        samples: [{ value: otlpExporterHandle?.exporter.status().queued ?? 0 }],
      },
      {
        name: 'harness_tool_window_samples',
        help: 'Tool calls observed in the failure-alert sliding window',
        type: 'gauge',
        samples: toolSampleSamples.length > 0 ? toolSampleSamples : [{ value: 0 }],
      },
      {
        name: 'harness_tool_failure_rate',
        help: 'Per-tool failure rate over the failure-alert sliding window (0..1)',
        type: 'gauge',
        samples: toolFailureSamples.length > 0 ? toolFailureSamples : [{ value: 0 }],
      },
    ];
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(formatPrometheusMetrics(metrics));
  } catch (error) {
    res.status(500).send(`# error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});

// ─── Agents (built-in + custom) ─────────────────────────────────────
// 4 routes (GET /api/agents, POST /api/agents, DELETE /api/agents/:id,
// POST /api/agents/:id/run) extracted to ./agentRoutes.ts. server.ts keeps
// BUILTIN_AGENT_ROLES + loadAgentDefinitions + refreshCustomAgentsIfStale +
// getCachedCustomAgentsSnapshot (chat handler + concierge use them); router
// takes callable deps so it sees mutable currentModel/ollamaHost/webRuntime/
// runtime-tool state at request time.
app.use(createAgentRouter({
  projectDir: PROJECT_DIR,
  getCurrentModel: () => currentModel,
  getOllamaHost: () => ollamaHost,
  refreshCustomAgentsIfStale,
  getCachedCustomAgentsSnapshot,
  createParentClient: (model, host) => webRuntime.createClient(model, host),
  getBaseTools: () => applyToolDisables(getRuntimeTools(PROJECT_DIR)),
}));

// ─── Squads ─────────────────────────────────────────────────────────
// Persistent agent rosters with regex-based routing rules. Routes
// extracted to ./squadRoutes.ts; server.ts still uses getSquad/
// routeMessage in the chat handler and listSquads in system health.
app.use(createSquadRouter({ projectDir: PROJECT_DIR }));

// ─── Identity ───────────────────────────────────────────────────────
// SOUL.md / USER.md / structured.json under .harness/identity/. Routes
// extracted to ./identityRoutes.ts so server.ts holds wiring, not handlers.
app.use(createIdentityRouter({
  projectDir: PROJECT_DIR,
  requireAuth: requireEscalationAuth,
  requireAuditReason,
  logger,
  isAutoUpdateSchedulerRunning: () => identityAutoUpdateScheduler !== null,
  runAutoUpdateNow: async () => {
    if (!identityAutoUpdateScheduler) {
      throw new Error('Identity auto-update scheduler is not running.');
    }
    // Use a far-future clock so the maintenance-window + interval gates
    // do not suppress the manual run. Kill switch and config still apply.
    return identityAutoUpdateScheduler.tick(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
  },
}));

// ─── System Health ──────────────────────────────────────────────────
// Aggregated dashboard endpoint surfacing live state across the daemon's
// background subsystems.

app.get('/api/system/health', async (_req, res) => {
  try {
    const [recentEvents, heartbeatHistory, conciergeLog, taskSummary, squadCount] = await Promise.all([
      queryEvents(PROJECT_DIR, { limit: 200 }).catch(() => []),
      readHeartbeatHistory(PROJECT_DIR, 20).catch(() => []),
      readConciergeLog(PROJECT_DIR, 20).catch(() => []),
      summarizeTasks(PROJECT_DIR).catch(() => null),
      listSquads(PROJECT_DIR).then((squads) => squads.length).catch(() => 0),
    ]);
    const [sessionHealth, evidenceHealth] = await Promise.all([
      SessionStorage.inspectStorage(PROJECT_DIR).catch((error) => ({
        status: 'error' as const,
        sessionDir: path.join(PROJECT_DIR, '.harness', 'sessions'),
        transcripts: 0,
        metaFiles: 0,
        corruptTranscriptFiles: 0,
        corruptTranscriptLines: 0,
        corruptMetaFiles: 0,
        unreadableFiles: 1,
        error: error instanceof Error ? error.message : String(error),
      })),
      inspectRunEvidence(PROJECT_DIR).catch((error) => ({
        status: 'error' as const,
        path: path.join(PROJECT_DIR, '.harness', 'evidence', 'runs.jsonl'),
        totalLines: 0,
        validEntries: 0,
        corruptLines: 0,
        unreadable: true,
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
    const lastHeartbeat = heartbeatHistory[heartbeatHistory.length - 1] ?? null;
    // Read kill-switch and scheduler status from their canonical sources
    // introduced in v0.5.6. The module-level `killSwitchActive` mirror is
    // kept in lockstep for the dozens of internal read sites, but the public
    // HTTP surface reads through `killSwitch.snapshot()` so the source of
    // truth is unambiguous. `schedulers` exposes every scheduler the
    // SchedulerRegistry knows about — including `uploads-auto-prune` and
    // `otlp-exporter`, which had no per-key surface before. The existing
    // per-scheduler keys are kept for backward compatibility because they
    // carry richer fields (enabled state, last_run_at, recent_runs).
    const killSnapshot = killSwitch.snapshot();
    res.json({
      kill_switch: { active: killSnapshot.active, reason: killSnapshot.reason },
      schedulers: schedulerRegistry.list(),
      capabilities: {
        active_grants: listActiveCapabilityGrants(capabilityGrants).length,
        total_grants: capabilityGrants.length,
      },
      heartbeat: {
        enabled: heartbeatEnabled(),
        running: Boolean(selfLearningHeartbeat),
        last_run_at: heartbeatLastRunMs ? new Date(heartbeatLastRunMs).toISOString() : null,
        recent_runs: heartbeatHistory,
        last_run_summary: lastHeartbeat,
      },
      triggers: {
        enabled: triggersEnabled(),
        running: Boolean(triggerScheduler),
      },
      automation: {
        running: Boolean(automationScheduler),
      },
      curator: {
        running: Boolean(curatorScheduler),
      },
      concierge: {
        enabled: conciergeEnabled(),
        auto_route: conciergeAutoRouteEnabled(),
        recent_decisions: conciergeLog,
      },
      squads: {
        total: squadCount,
        auto_route: squadAutoRouteEnabled(),
      },
      tasks: taskSummary,
      events: { recent_count: recentEvents.length },
      persistence: {
        sessions: sessionHealth,
        evidence: evidenceHealth,
        settings: { ...settingsPersistenceStatus },
        swallowed_failures: {
          total_recorded: getSwallowedFailureTotalCount(),
          dropped: getSwallowedFailureDroppedCount(),
        },
      },
      context: await buildContextHealth(),
      vision: await buildVisionHealth(),
      observability: {
        otel_export_enabled: otelExportEnabled(),
        otel_endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
        exporter_status: otlpExporterHandle ? otlpExporterHandle.exporter.status() : null,
      },
      feature_flags: { ...systemFeatureFlags },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Context + vision health helpers ────────────────────────────────
// Extracted so the System Health endpoint can surface (a) whether the
// configured contextMaxTokens looks stale relative to the active
// model's actual window, and (b) whether the configured vision model
// is actually installed. Both diagnoses are surfaced as small banners
// in the UI so users can spot misconfigurations without reading logs.
// Context caps the harness has shipped as defaults at various points.
// Auto-bump only when the configured value matches one of these — that
// way an explicit user choice (1024 in tests, or 16k for a deliberate
// throttle) is respected while a stale default (8192 / 4096) gets
// rescued when the model exposes a larger window.
const LEGACY_CONTEXT_DEFAULTS = new Set<number>([8192, 4096]);

function isAutoContextMode(configured: number): boolean {
  return !configured || configured <= 0 || LEGACY_CONTEXT_DEFAULTS.has(configured);
}

function resolveEffectiveContextMaxTokensFromKnown(configured: number, detected: number | null): number {
  if (isAutoContextMode(configured)) {
    return detected && detected > 0 ? Math.min(detected, 200_000) : DEFAULT_CONTEXT_MAX_TOKENS;
  }
  return detected && detected > 0 ? Math.min(configured, detected) : configured;
}

async function buildContextHealth(): Promise<{
  configured: number;
  detected: number | null;
  effective: number;
  auto_bumped: boolean;
  mode: 'auto' | 'capped';
  model: string;
  profile_cap?: number;
}> {
  const model = currentModel || '';
  const profile = model ? await getModelProfile(PROJECT_DIR, model).catch(() => undefined) : undefined;
  const profileCap = typeof profile?.contextMaxTokens === 'number' ? profile.contextMaxTokens : undefined;
  const globalCap = Number.isFinite(contextMaxTokens) ? contextMaxTokens : DEFAULT_CONTEXT_MAX_TOKENS;
  const configured = profileCap ?? globalCap;
  const detected = model ? await webRuntime.getModelContextWindow(model, ollamaHost).catch(() => null) : null;
  if (detected !== null) detectedContextMaxTokens = detected;
  const autoMode = isAutoContextMode(configured);
  const effective = resolveEffectiveContextMaxTokensFromKnown(configured, detected);
  const autoBumped = autoMode && detected !== null && detected > configured;
  const result: Awaited<ReturnType<typeof buildContextHealth>> = { configured, detected, effective, auto_bumped: autoBumped, mode: autoMode ? 'auto' : 'capped', model };
  if (profileCap !== undefined) result.profile_cap = profileCap;
  return result;
}

async function buildVisionHealth(): Promise<{
  configured: string;
  effective: string;
  installed: string[];
  ok: boolean;
  reason?: string;
}> {
  const configured = (mediaTools.visionModel || process.env.HARNESS_VISION_MODEL || '').trim();
  const installed = await webRuntime.listModels(ollamaHost).catch((): string[] => []);
  const visionInstalled = installed.filter((name) => isVisionCapableModelName(name));
  if (!configured) {
    const fallback = visionInstalled[0];
    return {
      configured: '',
      effective: fallback ?? '',
      installed: visionInstalled,
      ok: Boolean(fallback),
      reason: fallback ? undefined : 'No vision model is configured and no vision-capable model is installed.',
    };
  }
  // A configured model is usable when installed locally OR when it is a cloud
  // model (`:cloud`), which Ollama resolves remotely and never lists.
  if (isVisionModelUsable(configured, installed)) {
    return { configured, effective: configured, installed: visionInstalled, ok: true };
  }
  const fallback = visionInstalled[0];
  return {
    configured,
    effective: fallback ?? '',
    installed: visionInstalled,
    ok: Boolean(fallback),
    reason: fallback
      ? `Configured vision model "${configured}" is not installed; the harness will fall back to "${fallback}".`
      : `Configured vision model "${configured}" is not installed and no vision-capable fallback is available. Run \`ollama pull llava\`.`,
  };
}

app.patch('/api/system/feature-flags', (req, res) => {
  try {
    const body = req.body ?? {};
    const next: SystemFeatureFlags = { ...systemFeatureFlags };
    const valid: Array<keyof SystemFeatureFlags> = ['heartbeatEnabled', 'triggersEnabled', 'conciergeEnabled', 'conciergeAutoRoute', 'squadAutoRoute', 'otelExportEnabled'];
    for (const key of valid) {
      if (key in body) {
        const raw = (body as Record<string, unknown>)[key];
        if (raw === null || raw === undefined) delete next[key];
        else next[key] = Boolean(raw);
      }
    }
    systemFeatureFlags = next;
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
    // Re-apply scheduler configurations so changes take effect immediately.
    try { configureSelfLearningHeartbeat(); } catch (err) { recordSwallowed('configureSelfLearningHeartbeat', err); }
    try { configureTriggerScheduler(); } catch (err) { recordSwallowed('configureTriggerScheduler', err); }
    try { configureOtlpExporter(); } catch (err) { recordSwallowed('configureOtlpExporter', err); }
    res.json({ feature_flags: systemFeatureFlags });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Per-Model Context Profiles ─────────────────────────────────────
// Persistent per-model settings (today: contextMaxTokens) so switching
// from a tiny local model to a big cloud model does not drag a small
// global cap along. Storage: .harness/model-profiles.json.

app.get('/api/system/model-profiles', async (_req, res) => {
  try {
    const store: ModelProfileStore = await loadModelProfiles(PROJECT_DIR);
    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/system/model-profiles/:model', async (req, res) => {
  try {
    const model = String(req.params.model || '').trim();
    if (!model) { res.status(400).json({ error: 'model is required' }); return; }
    const body = (req.body ?? {}) as { contextMaxTokens?: unknown; validationProfile?: unknown; pairedVisionModel?: unknown };
    let store = await loadModelProfiles(PROJECT_DIR);
    if ('contextMaxTokens' in body) {
      const raw = body.contextMaxTokens;
      let nextValue: number | undefined;
      if (raw === null) nextValue = undefined;
      else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) nextValue = raw;
      else { res.status(400).json({ error: 'contextMaxTokens must be a non-negative number or null' }); return; }
      store = await setModelProfileField(PROJECT_DIR, model, 'contextMaxTokens', nextValue);
    }
    if ('validationProfile' in body) {
      const raw = body.validationProfile;
      let nextValue: string | undefined;
      if (raw === null || raw === '') nextValue = undefined;
      else if (typeof raw === 'string') nextValue = raw.trim().slice(0, 80) || undefined;
      else { res.status(400).json({ error: 'validationProfile must be a string or null' }); return; }
      store = await setModelProfileField(PROJECT_DIR, model, 'validationProfile', nextValue);
    }
    if ('pairedVisionModel' in body) {
      const raw = body.pairedVisionModel;
      let nextValue: string | undefined;
      if (raw === null || raw === '') nextValue = undefined;
      else if (typeof raw === 'string') nextValue = raw.trim().slice(0, 120) || undefined;
      else { res.status(400).json({ error: 'pairedVisionModel must be a string or null' }); return; }
      store = await setModelProfileField(PROJECT_DIR, model, 'pairedVisionModel', nextValue);
    }
    res.json({ model, profile: store.profiles[model] ?? null, store });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Promise Ledger ─────────────────────────────────────────────────
// Routes extracted to ./promiseRoutes.ts. server.ts still imports the
// ledger functions directly because schedulers + session bootstrap use
// them outside the HTTP surface (see checkObligations / createPromise
// call sites elsewhere in this file).
app.use(createPromiseRouter({ projectDir: PROJECT_DIR, recordSwallowed }));

// ─── Task Contract ───────────────────────────────────────────────────

/**
 * POST /api/task-contract/parse
 * Convert a freeform user message into a structured TaskContract.
 * Deterministic — no model call required.
 *
 * Body: { message: string, allowed_paths?: string[], extra_blocked_paths?: string[],
 *         validation?: string[], max_turns?: number, approval_required?: boolean }
 * Returns: TaskContract
 */
app.post('/api/task-contract/parse', (req, res) => {
  try {
    const { message, allowed_paths, extra_blocked_paths, validation, max_turns, approval_required } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string.' });
      return;
    }
    const contract = buildTaskContract(message, {
      allowed_paths: Array.isArray(allowed_paths) ? allowed_paths : undefined,
      extra_blocked_paths: Array.isArray(extra_blocked_paths) ? extra_blocked_paths : undefined,
      validation: Array.isArray(validation) ? validation : undefined,
      max_turns: typeof max_turns === 'number' ? max_turns : undefined,
      approval_required: typeof approval_required === 'boolean' ? approval_required : undefined,
    });
    res.json(contract);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Repo Map + Injection Defence ───────────────────────────────────
// Routes extracted to ./scanRoutes.ts. server.ts no longer imports
// repoMap or injectionDefence — both used exclusively by the HTTP layer.
app.use(createScanRouter({ projectDir: PROJECT_DIR }));

// ─── Memory conflict + staleness ─────────────────────────────────────
// Routes extracted to ./memoryHealthRoutes.ts. server.ts no longer
// imports memoryConflictDetector — used exclusively by the HTTP layer.
app.use(createMemoryHealthRouter({ projectDir: PROJECT_DIR }));

// ─── Config Profiles ─────────────────────────────────────────────────
// Routes extracted to ./profileRoutes.ts. server.ts still imports the
// other configProfiles surface (BUILTIN_PROFILES/applyProfile/filterToolsByProfile)
// for non-HTTP wiring.
app.use(createProfileRouter({ projectDir: PROJECT_DIR }));

// ─── Confidence Calibration + Golden Traces ─────────────────────────
// Routes extracted to ./evalRoutes.ts. server.ts still imports
// renderDriftReport directly for non-HTTP wiring.
app.use(createEvalRouter({ projectDir: PROJECT_DIR }));

// ─── Versioned Prompts ──────────────────────────────────────────────
// Routes extracted to ./promptsRoutes.ts. server.ts no longer imports
// versionedPrompts — it is used exclusively by the HTTP layer.
app.use(createPromptsRouter({ projectDir: PROJECT_DIR }));

// ─── Event Store ────────────────────────────────────────────────────
// Routes extracted to ./eventRoutes.ts. server.ts still imports emitEvent,
// queryEvents, summarizeEventStore for cross-cutting non-HTTP wiring
// (concierge auto-route, service lifecycle, subagent lifecycle, subsystems
// health, tool failure alerts).
app.use(createEventRouter({ projectDir: PROJECT_DIR }));

// ─── Done-State Verifier ────────────────────────────────────────────
// Routes extracted to ./doneStateRoutes.ts. server.ts no longer imports
// doneStateVerifier -- used exclusively by the HTTP layer.
app.use(createDoneStateRouter({ projectDir: PROJECT_DIR }));

// ─── Code Intelligence ──────────────────────────────────────────────
// Routes extracted to ./codeIntelRoutes.ts. server.ts still imports
// buildRepoGraph/saveRepoGraph/loadRepoGraph/summarizeRepo for non-HTTP
// wiring (setup health, subsystems health, heartbeat repo-graph rebuild).
app.use(createCodeIntelRouter({ projectDir: PROJECT_DIR }));

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

// /api/sessions/search-index/rebuild moved to ./sessionRoutes.ts.

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

// ─── Traces (in-memory tracer + on-disk exports) ─────────────────
// Routes extracted to ./traceRoutes.ts. server.ts still imports
// runtimeTracer + uses TRACES_DIR for non-HTTP wiring (cleanup at line
// 5440, system health at line 10340, system overview at line 10483).
app.use(createTraceRouter({ projectDir: PROJECT_DIR }));

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
  const verifiedTests = evidence.commands.reduce(
    (acc, c) => (c.testCounts ? { passed: acc.passed + c.testCounts.passed, failed: acc.failed + c.testCounts.failed, total: acc.total + c.testCounts.total } : acc),
    { passed: 0, failed: 0, total: 0 },
  );
  if (verifiedTests.total > 0) lines.push(`* Tests verified: ${verifiedTests.passed} passed, ${verifiedTests.failed} failed, ${verifiedTests.total} total`);
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

function starterActionPreview(starter: CapabilityTemplateStarter): Record<string, unknown> {
  if (starter.kind === 'document') return { kind: starter.kind, document: starter.document, writes: ['.harness/documents'] };
  if (starter.kind === 'automation') return { kind: starter.kind, automationJob: starter.automationJob, writes: ['.harness/automations/jobs.json'] };
  return { kind: starter.kind };
}

async function createGeneratedDocument(input: { title: string; template: DocumentTemplate; format: DocumentFormat; sourceLabel: string; content: string; evidence?: EvidenceCard }): Promise<{ metadata: GeneratedDocumentMetadata; content: string }> {
  const markdown = buildGeneratedDocumentMarkdown(input);
  const body = input.format === 'html' ? markdownToDocumentHtml(markdown, input.title) : markdown;
  await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${documentSlug(input.title)}-${crypto.randomBytes(3).toString('hex')}`;
  const extension = input.format === 'html' ? 'html' : input.format === 'pdf' ? 'pdf' : input.format === 'docx' ? 'docx' : 'md';
  const filename = `${id}.${extension}`;
  const filePath = path.join(DOCUMENTS_DIR, filename);
  if (input.format === 'pdf' || input.format === 'docx') await convertMarkdownDocument(markdown, filePath, input.format);
  else await fs.writeFile(filePath, body, 'utf-8');
  const stat = await fs.stat(filePath);
  const metadata: GeneratedDocumentMetadata = { id, title: input.title, template: input.template, format: input.format, filename, createdAt: new Date().toISOString(), sourceLabel: input.sourceLabel, size: stat.size };
  await fs.writeFile(path.join(DOCUMENTS_DIR, `${id}.json`), JSON.stringify(metadata, null, 2), 'utf-8');
  if (input.evidence) await appendLearningCandidate(PROJECT_DIR, createEvidenceLearningCandidate(metadata, input.evidence, markdown));
  return { metadata, content: input.format === 'pdf' || input.format === 'docx' ? markdown : body };
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

// Document generation routes extracted to ./documentRoutes.ts.
app.use(createDocumentRouter({
  projectDir: PROJECT_DIR,
  localDocumentConverters,
  normalizeDocumentTemplate,
  normalizeDocumentFormat,
  createGeneratedDocument: (input) => createGeneratedDocument({
    title: input.title,
    template: input.template as DocumentTemplate,
    format: input.format as DocumentFormat,
    sourceLabel: input.sourceLabel,
    content: input.content,
    evidence: input.evidence as EvidenceCard | undefined,
  }),
}));

// 8 /api/evals* routes moved to ./evalsRoutes.ts. server.ts retains
// currentModel / ollamaHost mutables and the sanitizeModelName +
// resolveContextMaxTokens helpers; the router gets a single
// buildLiveAdapter bridge that captures the live-mode client creation.
app.use(createEvalsRouter({
  projectDir: PROJECT_DIR,
  buildLiveAdapter: async (requestedModel) => {
    const activeModel = sanitizeModelName(requestedModel ?? currentModel);
    if (!activeModel) return null;
    const activeContextMaxTokens = await resolveContextMaxTokens(activeModel);
    const client = webRuntime.createClient(activeModel, ollamaHost, activeContextMaxTokens);
    return async (example) => {
      const response = await client.chat([{ role: 'user' as const, content: example.prompt ?? example.task }]);
      const toolCalls = response.message.tool_calls?.map((call) => call.function.name) ?? [];
      return { actualResponse: response.message.content ?? '', actualTools: toolCalls };
    };
  },
  getRuntimeTracerSnapshot: () => runtimeTracer.snapshot(),
}));

// ─── Benchmark routes (Gap #2) ───────────────────────────────────────

app.use(createBenchmarkRouter({
  projectDir: PROJECT_DIR,
  getCurrentModel: () => currentModel,
  sanitizeModelName,
  getBaseUrl: () => `http://127.0.0.1:${process.env.PORT ?? 3000}`,
}));

// ── Cost tracking rates + runtime storage ───────────────────────────
// Routes extracted to ./runtimeCostRoutes.ts.
app.use(createRuntimeCostRouter({ projectDir: PROJECT_DIR, tracesDir: TRACES_DIR }));

app.get('/api/permissions/pending', (_req, res) => {
  res.json({ prompts: permissionPrompts.list() });
});

// ─── Daily-spend cap (Fix #6) ──────────────────────────────────────────
// Status (read-only) + override (escalation-guarded, audit-logged). All four
// dailyBudget imports (addOverride/checkBudgetState/getEnvCapUsd/readTodaySpend)
// were HTTP-only — dropped from server.ts entirely. Router takes the two
// escalation helpers as callable deps.
app.use(createBudgetRouter({
  projectDir: PROJECT_DIR,
  requireEscalationAuth,
  requireAuditReason,
}));

// Audit log: every tool call (PreToolUse + PostToolUse + PostToolUseFailure)
// gets a JSONL entry in .harness/audit.log. Returns the most recent N entries.
app.get('/api/permissions/audit', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
    const entries = await readAuditLog(PROJECT_DIR, limit);
    res.json({ total: entries.length, entries });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Read-only view of the permission posture for the Permissions UI.
app.get('/api/permissions/state', (_req, res) => {
  checkAutonomyExpiry();
  res.json({
    mode: permissionMode,
    allowedModes: ALLOWED_PERMISSION_MODES,
    killSwitch: { active: killSwitchActive, reason: killSwitchReason },
    sandbox: sandboxSwitch.snapshot(),
    pendingCount: permissionPrompts.list().length,
    autonomyExpiresAt: autonomyExpiresAt > Date.now() ? new Date(autonomyExpiresAt).toISOString() : null,
    autonomyPreviousMode: autonomyExpiresAt > 0 ? autonomyPreviousMode : null,
  });
});

// Set or clear timed autonomy. When set, permissionMode is changed to dontAsk
// and will auto-revert to the previous mode when the timer expires.
app.post('/api/permissions/timed-autonomy', (req, res) => {
  try {
    if (!requireEscalationAuth(req, res, 'timed autonomy change')) return;
    const expiresInMinutes = typeof req.body?.expiresInMinutes === 'number' && req.body.expiresInMinutes > 0
      ? Math.min(req.body.expiresInMinutes, 1440) : undefined;
    if (expiresInMinutes) {
      const reason = requireAuditReason(req.body?.reason, res, 'Timed autonomy engagement');
      if (!reason) return;
      autonomyPreviousMode = permissionMode !== 'dontAsk' ? permissionMode : autonomyPreviousMode || 'default';
      permissionMode = 'dontAsk';
      autonomyExpiresAt = Date.now() + expiresInMinutes * 60_000;
      logger.info('Permissions', 'Timed autonomy engaged', { expiresInMinutes, previousMode: autonomyPreviousMode });
      appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.engaged', reason: `${reason} (engaged for ${expiresInMinutes}m, reverts to ${autonomyPreviousMode})` }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
    } else {
      // Clear timed autonomy (revert now)
      const clearTools = Boolean(req.body?.clearTimedTools);
      if (autonomyExpiresAt > 0) {
        permissionMode = autonomyPreviousMode;
        logger.info('Permissions', 'Timed autonomy cleared, reverted to ' + permissionMode);
        appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.cleared', reason: `Manually cleared, reverted to ${permissionMode}` }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
        revokeAutoGrantedCapabilities('Auto-revoked: timed autonomy manually cleared.');
      }
      if (clearTools && timedToolEnables.size > 0) {
        timedToolEnables.clear();
        logger.info('Permissions', 'Cleared timed tool enables along with timed autonomy');
      }
      autonomyExpiresAt = 0;
      autonomyPreviousMode = 'default';
    }
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
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
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? String(req.body.reason).trim().slice(0, 500)
        : 'Kill switch engaged from dashboard.';
      applyKillSwitchState(true, reason);
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
        revokeAutoGrantedCapabilities('Auto-revoked: kill switch engaged.');
      }
      logger.warn('Permissions', 'Kill switch engaged', { reason: killSwitchReason });
      runtimeTracer.recordEvent('permission.kill_switch_engaged', { reason: killSwitchReason });
    } else {
      applyKillSwitchState(false);
      logger.info('Permissions', 'Kill switch released');
      runtimeTracer.recordEvent('permission.kill_switch_released', {});
    }
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
    res.json({ killSwitch: { active: killSwitchActive, reason: killSwitchReason } });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Engage or release the sandbox-mode switch. Soft containment that
// narrows path / shell / network behaviour without disabling tools.
// Mirrors the kill-switch endpoint structure intentionally so operators
// can reason about the two controls the same way.
app.post('/api/permissions/sandbox', (req, res) => {
  try {
    const desired = Boolean(req.body?.active);
    if (desired) {
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? String(req.body.reason).trim().slice(0, 500)
        : 'Sandbox engaged from dashboard.';
      sandboxSwitch.engage(reason);
      logger.warn('Permissions', 'Sandbox engaged', { reason });
      runtimeTracer.recordEvent('permission.sandbox_engaged', { reason });
    } else {
      sandboxSwitch.release();
      logger.info('Permissions', 'Sandbox released');
      runtimeTracer.recordEvent('permission.sandbox_released', {});
    }
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
    res.json({ sandbox: sandboxSwitch.snapshot() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Tools routes moved to ./toolsRoutes.ts. server.ts retains the disabledTools
// + timedToolEnables mutables and bridges them via callable deps.
app.use(createToolsRouter({
  getToolStatus: () => {
    const registry = createToolRegistry(PROJECT_DIR);
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
    return {
      tools,
      toolsets,
      disabled: Array.from(disabledTools).sort(),
      capabilities: {
        items: capabilities,
        summary: summarizeCapabilityAlignment(capabilities),
        coverage: mapToolsToCapabilityCoverage(),
      },
    };
  },
  toggleTool: async (toolName, requestedEnabled, expiresInMinutes) => {
    await ensureSettingsLoaded();
    const registry = createToolRegistry(PROJECT_DIR);
    if (!registry.get(toolName)) return null;
    const currentlyEnabled = isToolEnabled(toolName);
    const desiredEnabled = requestedEnabled === undefined ? !currentlyEnabled : requestedEnabled;
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
    logger.info('Tools', 'Tool toggled', { tool: toolName, enabled: desiredEnabled, expiresInMinutes });
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
    return { name: toolName, enabled: desiredEnabled, enabledUntil, disabled: Array.from(disabledTools).sort() };
  },
  bulkToggleTools: async (names, desiredEnabled, expiresInMinutes) => {
    await ensureSettingsLoaded();
    const registry = createToolRegistry(PROJECT_DIR);
    const results: Array<{ name: string; enabled: boolean; enabledUntil?: string }> = [];
    for (const raw of names) {
      const toolName = raw.trim();
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
    saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
    return { toggled: results, disabled: Array.from(disabledTools).sort() };
  },
}));

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
    if (!requireEscalationAuth(req, res, 'capability grant creation')) return;
    await ensureSettingsLoaded();
    const capabilityId = String(req.body?.capabilityId ?? '').trim();
    const reason = requireAuditReason(req.body?.reason, res, 'Capability grant creation');
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
    capabilityGrants = sanitizeCapabilityGrants([...capabilityGrants, result.grant]);
    await saveSettingsToDisk();
    await appendCapabilityAuditEvent(PROJECT_DIR, { type: 'grant.created', capabilityId, grantId: result.grant.id, reason: result.grant.reason });
    logger.info('Capabilities', 'Capability grant created', { capabilityId, grantId: result.grant.id, expiresAt: result.grant.expiresAt });
    // Jarvis: bridge grant create → trust ladder acceptance.
    try {
      const snap = await loadTrustLadder(PROJECT_DIR);
      applyGrantToLadder(snap, capabilityId, 'create');
      await saveTrustLadder(PROJECT_DIR, snap);
    } catch { /* best-effort */ }
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
    // Jarvis: bridge grant revoke → trust ladder rejection.
    try {
      const snap = await loadTrustLadder(PROJECT_DIR);
      applyGrantToLadder(snap, before.capabilityId, 'revoke');
      await saveTrustLadder(PROJECT_DIR, snap);
    } catch { /* best-effort */ }
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

// 9 /api/automations* routes moved to ./automationRoutes.ts. server.ts
// retains getAutomationPolicyContext + createRunEvidence locally because
// both close over module-level state (killSwitchActive, capabilityGrants,
// currentModel, permissionMode). The router gets buildEvidenceCard +
// getPolicyContext bridges plus a thin notifyAutomationCompleted closure
// that fans out to Telegram and webhooks without exposing those modules.
app.use(createAutomationRouter({
  projectDir: PROJECT_DIR,
  ensureSettingsLoaded,
  isKillSwitchActive: () => killSwitchActive,
  getPolicyContext: () => getAutomationPolicyContext(),
  buildEvidenceCard: (input) => createRunEvidence(input),
  notifyAutomationCompleted: (results) => {
    const summary = results.map((r) => `• ${r.name}`).join('\n');
    sendTelegramNotification('Automation jobs completed', `${results.length} job(s) ran:\n${summary}`)
      .catch((err) => recordSwallowed('sendTelegramNotification', err));
    sendWebhookNotification('automation.completed', { executed: results.length, jobs: results })
      .catch((err) => recordSwallowed('sendWebhookNotification', err));
  },
}));

// ─── Mycelium graph API ──────────────────────────────────────────
// Routes extracted to ./myceliumRoutes.ts. server.ts still imports
// createMycelialRouter for the chat handler and heartbeat seeding.
app.use(createMyceliumRouter({ projectDir: PROJECT_DIR }));

// Enable or disable a single tool at runtime. Disabled tools are filtered out
// of the agent's tool list before each chat turn.
// Pass { enabled: true, expiresInMinutes: N } to enable for a limited time.
// /api/tools/:name/toggle + /api/tools/bulk-toggle moved to ./toolsRoutes.ts (createToolsRouter mount above).

// --- Workflows ---
// 10 routes extracted to ./workflowRoutes.ts. server.ts keeps the
// workflowRegistry instance + WORKFLOWS_DIR const here because
// restoreRuns() runs at boot (line 8267) and system-overview (line 9084)
// surfaces the workflows directory. The router takes a buildRunContext
// callable so it sees server.ts's mutable permissionMode + webRuntime
// bindings at execute time.
app.use(createWorkflowRouter({
  projectDir: PROJECT_DIR,
  workflowsDir: WORKFLOWS_DIR,
  workflowRegistry,
  buildRunContext: () => ({
    tools: applyToolDisables(getRuntimeTools(PROJECT_DIR)),
    permissions: webRuntime.createPermissionEngine(permissionMode),
  }),
}));

app.post('/api/permissions/:id/resolve', (req, res) => {
  try {
    const promptId = safeLocalId(req.params.id);
    if (!promptId) { res.status(400).json({ error: 'Invalid permission prompt id.' }); return; }
    const allowed = Boolean(req.body?.allowed);
    const pendingBefore = permissionPrompts.list().find((p) => p.id === promptId);
    const resolved = permissionPrompts.resolve(promptId, allowed, req.body?.reason?.toString());
    if (!resolved) { res.status(404).json({ error: 'Permission prompt not found.' }); return; }
    runtimeTracer.recordEvent('permission.prompt_resolved', { promptId, allowed });
    // Jarvis: feed outcome into the trust ladder so it learns over time.
    if (pendingBefore?.call?.name) {
      void recordPermissionOutcome(PROJECT_DIR, pendingBefore.call.name, allowed ? 'allowed' : 'denied').catch((err) => recordSwallowed('recordPermissionOutcome', err));
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const PERMISSION_RECOVERY_SMOKE_MESSAGE = 'trigger permission recovery smoke';

function writePermissionRecoverySmokeChat(res: express.Response): void {
  const deniedOutput = "Permission denied for 'file_write': Nervous System requires verification";
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.flushHeaders();
  const events: LoopEvent[] = [
    { type: 'tool_call', call: { id: 'smoke-denied-write', name: 'file_write', input: { path: 'agent-outputs/blocked.txt', content: 'blocked' } } },
    { type: 'tool_result', call: { id: 'smoke-denied-write', name: 'file_write', input: { path: 'agent-outputs/blocked.txt' } }, result: { success: false, output: deniedOutput } },
    { type: 'done', reason: 'completed', turns: 1 },
  ];
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function parseExplicitSkillInvocation(messageText: string): { name: string; input: string } | null {
  const match = messageText.trim().match(/^Use the skill:\s*([a-z0-9][\w-]*)(?:\s+with input:\s*([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1], input: (match[2] || '').trim() };
}

async function loadExplicitSkillContext(messageText: string): Promise<{ skill?: SkillDefinition; context: string }> {
  const invocation = parseExplicitSkillInvocation(messageText);
  if (!invocation) return { context: '' };

  // Workspace skills outrank global/repo ones of the same name (last wins).
  const skills = await loadSkillsFromDirs([GLOBAL_SKILLS_DIR, REPO_SKILLS_DIR, SKILLS_DIR]).catch(() => []);
  const skill = skills.find((candidate) => candidate.name.toLowerCase() === invocation.name.toLowerCase());
  if (!skill) return { context: '' };

  recordSkillUse(PROJECT_DIR, skill.name).catch((err) => recordSwallowed('recordSkillUse', err));
  const inputBlock = invocation.input
    ? `\n\n[User input for this skill]\n${invocation.input}`
    : '\n\n[User input for this skill]\nNo extra input was supplied. Ask one concise question if the skill needs business, product, audience, or goal details before producing useful output.';

  return {
    skill,
    context: `--- Explicitly Selected Skill ---\nThe user selected the runtime skill \"${skill.name}\" from the slash palette. Apply this skill now. Use the instructions below as authoritative task context for this turn.\n\n${skill.description}\n\n${skill.content}${inputBlock}`,
  };
}

// Chat endpoint — runs the agent loop and streams events as SSE
app.post('/api/chat', async (req, res) => {
  await ensureSettingsLoaded();
  checkAutonomyExpiry();
  lastUserActivityMs = Date.now();
  const { message, model } = req.body;
  if (!message) { res.status(400).json({ error: 'message is required' }); return; }

  // Experiment prompt-mutation lever: when explicitly enabled, a request may
  // supply its own system prompt so the experiment runner can evaluate
  // prompt-scope variants. Gated behind an env flag because overriding the
  // system prompt from request bodies is a privilege a normal chat client
  // must not have.
  const requestPromptOverride = (process.env.HARNESS_EXPERIMENT_PROMPT_OVERRIDE === '1'
    && typeof req.body?.systemPrompt === 'string'
    && req.body.systemPrompt.length > 0)
    ? String(req.body.systemPrompt).slice(0, 20_000)
    : '';

  // Best-effort: if the user message contains a trigger phrase from any
  // installed skill, record a use event for that skill so the curator can
  // see real-world relevance, not just explicit `skill` tool calls.
  const messageText = typeof message === 'string' ? message : (typeof (message as { content?: unknown })?.content === 'string' ? (message as { content: string }).content : '');
  if (process.env.HARNESS_UI_SMOKE_CHAT === '1' && messageText === PERMISSION_RECOVERY_SMOKE_MESSAGE) {
    writePermissionRecoverySmokeChat(res);
    return;
  }
  if (messageText) {
    loadSkillsDir(SKILLS_DIR)
      .then((skills) => {
        const matched = matchSkillTrigger(skills, messageText);
        if (matched) recordSkillUse(PROJECT_DIR, matched.name).catch((err) => recordSwallowed('recordSkillUse', err));
      })
      .catch((err) => recordSwallowed('server.ts:5869', err));
  }

  refreshCapabilityRegistry();

  // Tier 0: Deterministic shortcut — bypass model entirely for simple computations.
  if (messageText) {
    // Tier 0a: /goal slash command — expand intent into autonomy tasks
    // and append them to IMPLEMENTATION_PLAN.md. Runs before the
    // deterministic shortcut so the command pattern always wins, and
    // before the model so we never pay tokens for a structural command.
    try {
      const goalResult = await tryGoalSlashCommand(messageText, { projectDir: PROJECT_DIR });
      if (goalResult.handled) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: 'text', content: goalResult.response })}\n\n`);
        if (goalResult.mutated && goalResult.tasks.length > 0) {
          // Side-channel hint for the chat UI: render a one-click Start
          // button under the response so beginners do not have to hunt
          // for the Autonomy tab. The response markdown still says
          // "Start the autonomy loop to begin work." — the button is
          // additive, not a replacement, and degrades gracefully when
          // the client does not handle this event.
          res.write(`data: ${JSON.stringify({ type: 'goal_appended', taskCount: goalResult.tasks.length, planPath: 'IMPLEMENTATION_PLAN.md' })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done', reason: 'goal_slash_command' })}\n\n`);
        emitEvent(PROJECT_DIR, 'system', 'goal_slash_command', {
          mutated: goalResult.mutated,
          taskCount: goalResult.tasks.length,
          intent: messageText.slice(0, 200),
        }, 'system').catch((err) => recordSwallowed('emitEvent', err));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch (err) {
      recordSwallowed('tryGoalSlashCommand', err);
      // Fall through to normal chat path on error.
    }

    // Tier 0b: Morning priority — `priority: <answer>` / `/priority …`.
    // Stores the day's top priority and acknowledges. Skips the model
    // entirely (no token spend, no loop).
    try {
      const priorityAnswer = parsePrioritySetCommand(messageText);
      if (priorityAnswer) {
        const stored = await setPriorityForToday(PROJECT_DIR, priorityAnswer);
        const reply = `✅ Top priority for **${stored.date}** set: **${stored.answer}**\n\nThis will appear at the top of your daily brief until the day ends.`;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: 'text', content: reply })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', reason: 'morning_priority_set' })}\n\n`);
        emitEvent(PROJECT_DIR, 'system', 'morning_priority_set', { date: stored.date }, 'system').catch((err) => recordSwallowed('emitEvent', err));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch (err) {
      recordSwallowed('setPriorityForToday', err);
    }

    // Tier 0c: All other slash commands — /wiki, /research, /memory-wiki,
    // /kanban, /brief. Runs the service-layer handler and streams back
    // the result without invoking a model.
    try {
      const pdfAttachments = await resolveAttachmentPdfPaths(req.body?.attachments);
      const slashResult = await routeSlashCommand(messageText, PROJECT_DIR, { pdfAttachments });
      if (slashResult.handled) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: 'text', content: slashResult.response })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', reason: slashResult.reason })}\n\n`);
        if (slashResult.eventPayload) {
          emitEvent(PROJECT_DIR, 'system', slashResult.reason, slashResult.eventPayload, 'system').catch((err) => recordSwallowed('emitEvent', err));
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch (err) {
      recordSwallowed('routeSlashCommand', err);
    }

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
      emitEvent(PROJECT_DIR, 'system', 'deterministic_shortcut', { type: shortcut.type, input: messageText.slice(0, 100) }, 'system').catch((err) => recordSwallowed('emitEvent', err));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  // Tier 0.5a: Squad auto-route — when HARNESS_SQUAD_AUTO_ROUTE is set and
  // the chat request specifies a squadId, the squad's routing rules pick
  // the agent and we delegate directly. Falls through on failure.
  // sessionId is opt-in: when provided, the server persists the squadId so
  // future turns from the same session do not need to re-pass it.
  const sessionIdHint = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim() ? req.body.sessionId.trim() : '';
  const explicitSquadId = typeof req.body?.squadId === 'string' && req.body.squadId.trim() ? req.body.squadId.trim() : undefined;
  const squadId = sessionIdHint
    ? await resolveSessionSquad(PROJECT_DIR, sessionIdHint, explicitSquadId).catch(() => explicitSquadId)
    : explicitSquadId;
  if (messageText && squadId && squadAutoRouteEnabled()) {
    try {
      const parentClient = webRuntime.createClient(model || currentModel || 'llama3.1:8b', ollamaHost);
      const auto = await maybeSquadAutoRoute(squadId, messageText, parentClient);
      if (auto) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const text = `${auto.summary}\n\n*Squad ${auto.squadId} auto-routed to ${auto.agentId} — ${auto.reason}.*`;
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', reason: 'squad_auto_route' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch (error) {
      logger.warn('Squad', 'Squad auto-route failed; falling through', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Tier 0.5: Concierge auto-route — when enabled, the concierge runs the
  // suggested sub-agent directly and streams back its summary instead of
  // invoking the main loop. The ordinary concierge note path still fires
  // when auto-route is off; both modes coexist.
  if (messageText && conciergeEnabled() && conciergeAutoRouteEnabled()) {
    try {
      const parentClient = webRuntime.createClient(model || currentModel || 'llama3.1:8b', ollamaHost);
      const autoRoute = await maybeConciergeAutoRoute(messageText, parentClient);
      if (autoRoute) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const text = `${autoRoute.summary}\n\n*Concierge auto-routed to ${autoRoute.agentId} — ${autoRoute.reason}.*`;
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', reason: 'concierge_auto_route' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch (error) {
      // Auto-route failures fall through to the normal model loop. We log
      // but never block the user's turn.
      logger.warn('Concierge', 'Auto-route failed; falling through to main loop', { error: error instanceof Error ? error.message : String(error) });
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
    await appendRunEvidence(PROJECT_DIR, evidenceCard).catch((err) => recordSwallowed('appendRunEvidence', err));
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

  const requestedModel = model || currentModel;
  if (!requestedModel) { res.status(400).json({ error: 'No model selected.' }); return; }
  const routedModel = await resolveChatModelForRequest(requestedModel, messageText);
  let activeModel = routedModel.model;
  // One-shot readiness escalation: a prior low-readiness turn in this session
  // may have queued a stronger model (only when the opt-in policy flag and a
  // sessionId are both present). Honor it once, then clear it.
  if (modelRouting.autoEscalateOnLowReadiness && sessionIdHint) {
    const queuedModel = pendingReadinessEscalations.get(sessionIdHint);
    if (queuedModel && queuedModel !== activeModel) {
      pendingReadinessEscalations.delete(sessionIdHint);
      activeModel = queuedModel;
      emitEvent(PROJECT_DIR, 'model', 'escalation_applied', { applied: queuedModel, requested: requestedModel, sessionId: sessionIdHint }, 'system').catch((err) => recordSwallowed('emitEvent', err));
    }
  }

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
  if (routedModel.routed) {
    res.write(`data: ${JSON.stringify({ type: 'model_routed', from: routedModel.from, to: routedModel.model, tier: routedModel.tier, taskType: routedModel.taskType, risk: routedModel.risk, reason: routedModel.reason, reasons: routedModel.reasons })}\n\n`);
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
  const stashedModeClassification = (req as any).__modeClassification as { mode: HarnessMode } | undefined;
  const activeOutputValidation = skipValidationThisTurn
    ? { ...outputValidation, enabled: false, selectionSource: 'manual-selected' as const, selectionReason: 'Validation skipped for this turn by user request.' }
    : effectiveOutputValidationForMessage(message, stashedModeClassification?.mode);
  const client = webRuntime.createClient(activeModel, ollamaHost, activeContextMaxTokens);
  let tools = webRuntime.getTools();
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

  // Start a new learning session for tracking.
  // Construct a per-chat recorder bound to PROJECT_DIR. The legacy
  // webRuntime.startNewSession() resets the process-wide default recorder
  // (still used by CLI / older callers); we use our own per-request recorder
  // so concurrent chats don't race on shared module-level state and learning
  // artifacts are written under PROJECT_DIR instead of process.cwd().
  webRuntime.startNewSession();
  const chatLearningRecorder = new LearningRecorder(PROJECT_DIR);
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
  const basePrompt = requestPromptOverride || systemPromptOverride ||
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
  const identityPrefix = buildAgentIdentityPrefix();
  const promptWithPersonality = identityPrefix
    ? `${identityPrefix}\n\n${basePrompt}`
    : basePrompt;

  // Use evolved prompt — layers in learned patterns and self-improvements
  const evolvedPrompt = await chatLearningRecorder.getEvolvedPrompt(promptWithPersonality);
  // Jarvis: pass the latest user message as the recall query so the
  // knowledge graph can inject relevant entity/fact hits automatically.
  const recallQuery = typeof messageText === 'string' ? messageText.slice(0, 240) : undefined;
  const baseSystemPrompt = await webRuntime.assembleSystemContext({ systemPrompt: withRoutingPolicy(evolvedPrompt), projectDir, skillsDir: SKILLS_DIR, recallProjectDir: PROJECT_DIR, recallQuery, ragProjectDir: PROJECT_DIR, ragQuery: recallQuery, ragOllamaHost: ollamaHost, palaceProjectDir: PROJECT_DIR, sessionSearchProjectDir: PROJECT_DIR, sessionSearchQuery: recallQuery, ccmemUrl: ccmemUrl || undefined, ccmemQuery: recallQuery });
  const attachmentsBlock = await buildAttachmentsContextBlock(req.body?.attachments);
  const explicitSkill = messageText ? await loadExplicitSkillContext(messageText) : { context: '' };

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
    myceliumRouter.seedToolNodes(tools.map((t) => ({ name: t.name, description: t.description })));
    // Seed skills from runtime and repo directories
    try {
      const [runtimeSkills, repoSkills, globalSkills] = await Promise.all([
        loadSkillsDir(SKILLS_DIR).catch(() => []),
        loadSkillsDir(REPO_SKILLS_DIR).catch(() => []),
        loadSkillsDir(GLOBAL_SKILLS_DIR).catch(() => []),
      ]);
      const allSkills = [...runtimeSkills, ...repoSkills, ...globalSkills];
      myceliumRouter.seedSkillNodes(allSkills.map((s) => ({ name: s.name, description: s.description, domain: s.domain })));
    } catch (err) { recordSwallowed('mycelium.seedSkillNodes', err); }
    // Seed semantic memory entries
    try {
      const memResults = await searchSemanticMemory(PROJECT_DIR, message.slice(0, 200));
      if (memResults.length > 0) {
        myceliumRouter.seedMemoryNodes(memResults.slice(0, 10).map((r) => ({ id: r.entry.id, text: r.entry.text, kind: r.entry.kind })));
      }
    } catch (err) { recordSwallowed('mycelium.seedMemoryNodes', err); }
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
        formatMyceliumContextText(myceliumResult.contextText, MYCELIUM_CONTEXT_MAX_CHARS) +
        safetyBlock;
    }
    // Promote the advisory route into an actual tool shortlist for this
    // turn. Off by default; opt in with HARNESS_CHAT_MYCELIUM_SHORTLIST=1.
    // deriveToolShortlist returns the full set when routedToolNames is
    // empty, so cold-graph turns degrade to today's behaviour.
    if (process.env.HARNESS_CHAT_MYCELIUM_SHORTLIST === '1' && myceliumResult.nodes.length > 0) {
      try {
        const shortlist = deriveToolShortlist(toolNamesFromRoute(myceliumResult), tools);
        if (shortlist.length > 0) tools = shortlist;
      } catch (err) { recordSwallowed('mycelium.chatShortlist', err); }
    }
  } catch (error) {
    logger.warn('Mycelium', 'Context routing failed', { error: error instanceof Error ? error.message : String(error) });
  }

  // Nervous System: inspect query, evaluate reflexes, calculate attention.
  // One controller per chat request — prior versions shared a module-level
  // singleton across concurrent chats, which tangled signal histories.
  const chatNervousSystem = new NervousSystemController();
  chatNervousSystem.reset();
  const nervousResult = chatNervousSystem.inspectQuery(messageText, myceliumClassification?.type ?? 'general');
  // Re-feed: pull recent persisted signals from prior runs and raise this
  // turn's risk level if the same taskType has shown critical/high signals
  // recently. Without this, every chat starts from a blank nervous slate
  // even if the prior turn just hit a critical reflex.
  try {
    const priorSignals = await NervousSystemController.readPersistedSignals(PROJECT_DIR, 50);
    const taskType = myceliumClassification?.type ?? 'general';
    const matchingConcerns = priorSignals.filter((s) =>
      (s.taskType === taskType || s.taskType === undefined) &&
      (s.severity === 'critical' || s.severity === 'high')
    );
    if (matchingConcerns.length > 0) {
      const hasCritical = matchingConcerns.some((s) => s.severity === 'critical');
      if (hasCritical && nervousResult.runState.riskLevel !== 'critical') {
        nervousResult.runState.riskLevel = 'critical';
      } else if (!hasCritical && nervousResult.runState.riskLevel === 'low') {
        nervousResult.runState.riskLevel = 'medium';
      }
      const summary = `Prior runs flagged ${matchingConcerns.length} ${hasCritical ? 'critical' : 'high-severity'} signal(s) for taskType=${taskType}.`;
      nervousResult.runState.safetyNotes.push(summary);
      runtimeTracer.recordEvent('nervous.prior_signals_raised', {
        taskType,
        priorCount: matchingConcerns.length,
        hadCritical: hasCritical,
        newRiskLevel: nervousResult.runState.riskLevel,
      });
    }
  } catch (err) {
    recordSwallowed('nervous.readPersistedSignals', err);
  }
  // Snapshot-on-recovery: if the nervous system enters recovery mode (or
  // flags this turn as high-risk), capture a pre-recovery snapshot so a
  // restore point exists before the agent tries to repair its state.
  // Best-effort and bounded: one snapshot per chat turn, swallowed errors
  // routed through recordSwallowed for visibility.
  if (nervousResult.runState.recoveryMode || nervousResult.runState.riskLevel === 'high' || nervousResult.runState.riskLevel === 'critical') {
    snapshots
      .take(PROJECT_DIR, `pre-recovery-${Date.now()}`)
      .then((meta) => {
        runtimeTracer.recordEvent('nervous.snapshot_taken', {
          snapshotId: meta.id,
          reason: nervousResult.runState.recoveryMode ? 'recovery_mode' : 'high_risk',
          riskLevel: nervousResult.runState.riskLevel,
        });
      })
      .catch((err) => recordSwallowed('snapshots.pre_recovery', err));
  }
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
  } catch (err) { recordSwallowed('codeIntel.loadRepoGraph', err); }
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
- Prefer web_search + web_read for initial research, fall back to browser_navigate for blocked sites.

BASH TOOL RULES (critical on Windows):
- The bash tool is not an interactive shell. It runs one executable plus arguments from the Harness project directory: ${PROJECT_DIR}.
- Do NOT use cd, &&, ;, |, redirection, or shell built-ins. Those are blocked. Run the target command directly, such as git status, npm test, or node script.js.
- Do NOT invent Linux paths such as /harness. This workspace is Windows. If an absolute path is unavoidable, use a real Windows path like C:\\AI\\Harness and quote it.
- Prefer commands that work from the current project directory. For git, use git status or git diff instead of git -C unless the user names a different directory.

CONTEXT HYGIENE (critical for long tasks):
- Do NOT call file_read on a file you just successfully file_wrote in this same turn. You already have the content — re-reading wastes tokens and frequently triggers cloud-model stream failures on the next turn.
- After a successful file_write, the immediate next step is the next real action (send the email, update the manifest, finish the task) — NOT verification.
- If you genuinely need to confirm a write happened, trust the file_write tool result; it returns the byte count and path.`;

  const conciergeNote = buildConciergeNote(typeof message === 'string' ? message : '');
  const squadNote = await buildSquadRoutingNote(squadId, typeof message === 'string' ? message : '').catch(() => null);
  const identityBlock = await renderIdentityForPrompt(PROJECT_DIR, { maxChars: 4000 }).catch(() => '');
  const recentAuditBlock = await renderRecentAuditForPrompt(PROJECT_DIR).catch(() => '');

  // Skill-gap hint ("if nothing exists, create it"): when the message looks
  // like a task but NO installed skill matches its triggers, tell the agent it
  // MAY author one with create_skill. This is a soft, model-initiated nudge —
  // never a forced auto-write. Without it, a no-match is silently a no-op, so
  // the harness can never grow a new skill from an unmet need. Kept conservative
  // (only fires on action-verb messages) to avoid nudging on questions/chat.
  let skillGapNote = '';
  try {
    const msgForSkill = typeof message === 'string' ? message : '';
    const taskShaped = /\b(build|create|make|implement|write|add|generate|scaffold|set\s?up|automate|scrape|crawl|download|convert|refactor|integrate|deploy|configure|install|parse|extract|monitor|schedule)\b/i.test(msgForSkill);
    if (msgForSkill && taskShaped) {
      const installedSkills = await loadSkillsFromDirs([GLOBAL_SKILLS_DIR, REPO_SKILLS_DIR, SKILLS_DIR]).catch(() => []);
      if (!matchSkillTrigger(installedSkills, msgForSkill)) {
        skillGapNote = '--- Skill gap ---\nNo installed skill matched this request. If this task is a reusable, repeatable procedure you expect to recur, you MAY capture it as a skill with the create_skill tool after completing the work. Only do this for genuinely reusable workflows — never for a one-off request.';
      }
    }
  } catch (err) { recordSwallowed('skillGapNote', err); }

  const systemPrompt = [baseSystemPrompt, identityBlock, attachmentsBlock, explicitSkill.context, myceliumContext, codeIntelContext, nervousContext, recentAuditBlock, squadNote, conciergeNote, skillGapNote, toolSynthesisNudge].filter(Boolean).join('\n\n');

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
      const motor = chatNervousSystem.checkToolPermission(call.name, call.input);
      runtimeTracer.recordEvent('nervous.motor_decision', { tool: call.name, decision: motor.decision, reason: motor.reason });
      if (motor.decision === 'BLOCK' || motor.decision === 'INTERRUPT_AND_RECOVER') {
        return { allowed: false, reason: `Nervous System ${motor.decision}: ${motor.reason}` };
      }
      if (motor.decision === 'ALLOW_DRY_RUN_ONLY' && !hasDryRunIntent(call.input)) {
        // email_draft is itself the dry-run version of email_send (it writes a
        // .eml file rather than sending) so the dry-run requirement is a no-op.
        // In Full Autonomy (dontAsk) the user has explicitly asked us to stop
        // gating; record the bypass so the audit trail still shows it happened.
        if (call.name === 'email_draft' || shouldBypassNervousVerification()) {
          runtimeTracer.recordEvent('nervous.dry_run_bypassed', { tool: call.name, reason: motor.reason, permissionMode });
          return { allowed: true, reason: `Nervous System dry-run requirement bypassed for '${call.name}' in auto-approve mode: ${motor.reason}` };
        }
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
        if (shouldBypassNervousVerification()) {
          runtimeTracer.recordEvent('nervous.confirmation_bypassed', { tool: call.name, reason: motor.reason, permissionMode });
          return { allowed: true, reason: `Nervous System confirmation bypassed for '${call.name}' in auto-approve mode: ${motor.reason}` };
        }
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
    learningRecorder: chatLearningRecorder,
    // Bridge inspector requireApproval into the same prompt broker the
    // permission engine uses, so users see one queue. Routed through the
    // current `permissionMode`: dontAsk auto-allows (matches existing
    // permission behaviour); ask/acceptEdits surface the prompt.
    onApprovalRequired: async (info) => {
      if (permissionMode === 'dontAsk') {
        runtimeTracer.recordEvent('inspector.auto_approved', {
          tool: info.call.name,
          inspector: info.inspectorName,
          reason: info.reason,
        });
        return true;
      }
      runtimeTracer.recordEvent('permission.prompt_created', {
        tool: info.call.name,
        reason: info.reason,
        source: `inspector.${info.inspectorName}`,
      });
      const result = await permissionPrompts.request(
        info.call,
        `Inspector '${info.inspectorName}': ${info.reason}${info.warning ? ` (${info.warning})` : ''}`,
      );
      return result.allowed;
    },
    // LLM-graded safety judge for AdversaryInspector. Reuses the chat
    // client; only invoked when HARNESS_INSPECTOR_ADVERSARY=1 and
    // <project>/.harness/adversary.md exists.
    adversaryJudge: createLlmAdversaryJudge(client),
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
  // Honest run model locality, folded once the cost rollup is built; read
  // after the loop to decide the offline-guarantee badge. Defaults to
  // 'unknown' so a run that never reaches the rollup never claims offline.
  let runLocality: ModelLocality = 'unknown';

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
    const runUsageSamples: RunUsageSample[] = [];
    for await (const event of webRuntime.runQueryLoop(config, deps, messages)) {
      if (event.type === 'tool_result') {
        toolCallCount++;
        if (event.result?.success) toolSuccessCount++;
        // Nervous System: inspect tool result
        chatNervousSystem.onToolResult(event.call.name, Boolean(event.result?.success), String(event.result?.output ?? ''));
        chatNervousSystem.onToolCallSequence(toolCallSequence);
        evidenceTools.push({
          name: event.call.name,
          success: Boolean(event.result?.success),
          inputSummary: summarizeForEvidence(event.call.input),
          outputSummary: summarizeForEvidence(event.result?.output),
        });
        evidenceFiles.push(...evidenceFilesFromTool(event.call.name, event.call.input));
        if (event.call.name === 'bash' && typeof event.call.input.command === 'string') {
          const testCounts = parseJestSummary(String(event.result?.output ?? '')) ?? undefined;
          evidenceCommands.push({ command: event.call.input.command, success: Boolean(event.result?.success), outputSummary: summarizeForEvidence(event.result?.output), testCounts });
        }
        if (event.call?.name) {
          toolCallSequence.push(event.call.name);
          const stats = toolStats.get(event.call.name) ?? { success: 0, total: 0 };
          stats.total++;
          if (event.result?.success) stats.success++;
          toolStats.set(event.call.name, stats);
          // Sliding-window alert tracker. Fires once per tool when the
          // recent failure rate crosses the configured threshold.
          toolFailureAlerts.record(event.call.name, Boolean(event.result?.success));
        }
        // Event store: emit per-tool events for audit trail + postmortem analysis.
        emitEvent(PROJECT_DIR, 'tool', event.result?.success ? 'tool_succeeded' : 'tool_failed', {
          tool: event.call.name,
          input_summary: summarizeForEvidence(event.call.input)?.slice(0, 200),
          output_summary: summarizeForEvidence(event.result?.output)?.slice(0, 200),
          session_id: session.getSessionId(),
        }, 'agent', session.getSessionId()).catch((err) => recordSwallowed('server.ts:6427', err));
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
            }, 'agent', session.getSessionId()).catch((err) => recordSwallowed('server.ts:6438', err));
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
        recordSessionCompleted(PROJECT_DIR, activeModel).catch((err) => recordSwallowed('recordSessionCompleted', err));
        // Record average turn duration for adaptive time budget.
        if (turnCount > 0) {
          recordAvgTurnDuration(PROJECT_DIR, activeModel, Math.round(totalTurnMs / turnCount)).catch((err) => recordSwallowed('recordAvgTurnDuration', err));
        }
      }
      if (event.type === 'turn_complete') {
        turnCount++;
        totalTurnMs += (event as { durationMs?: number }).durationMs ?? 0;
      }
      if (event.type === 'synthesis_fired') {
        recordSynthesisFired(PROJECT_DIR, activeModel).catch((err) => recordSwallowed('recordSynthesisFired', err));
      }
      if (event.type === 'auto_continue') {
        autoContinueCount++;
        chatLearningRecorder.recordAutoContinue(activeModel);
      }
      if (event.type === 'usage') {
        // Accumulate per-call locality + tokens for an honest run-level cost
        // rollup emitted once the loop completes (see run_cost below).
        runUsageSamples.push({
          locality: event.locality ?? 'unknown',
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
        });
      }
      if (event.type === 'governed_shadow') {
        // Live producer for the governed review queue. The event only fires
        // when HARNESS_GOVERNED_SHADOW is on, so this stays dormant by default.
        // Enqueue is fire-and-forget and never blocks or alters the stream;
        // nothing is written to the brain here — items wait for human approval.
        try {
          enqueueFromGoverned(event.governed);
        } catch (err) {
          recordSwallowed('enqueueFromGoverned', err);
        }
      }
      for (const fallbackEvent of drainRemoteProviderFallbackEvents()) {
        res.write(`data: ${JSON.stringify(fallbackEvent)}\n\n`);
      }
      for (const retryEvent of drainOllamaChatRetryEvents()) {
        res.write(`data: ${JSON.stringify(retryEvent)}\n\n`);
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
    // Honest run-level cost rollup: claims a $0 all-local run only when every
    // model call was provably local; a single cloud call makes the run billed.
    const runCost = summarizeRunCost(runUsageSamples);
    runLocality = runCost.locality;
    res.write(`data: ${JSON.stringify({
      type: 'run_cost',
      ...runCost,
    })}\n\n`);
    // Honest answer-confidence signal: surfaces an explicit abstention or a
    // model-stated confidence band, and stays silent ('unstated') rather than
    // fabricating a number when the answer expressed none.
    if (assistantTextBuffer.trim()) {
      res.write(`data: ${JSON.stringify({
        type: 'answer_confidence',
        ...assessAnswerConfidence(assistantTextBuffer),
      })}\n\n`);
    }
    for (const fallbackEvent of drainRemoteProviderFallbackEvents()) {
      res.write(`data: ${JSON.stringify(fallbackEvent)}\n\n`);
    }
    for (const retryEvent of drainOllamaChatRetryEvents()) {
      res.write(`data: ${JSON.stringify(retryEvent)}\n\n`);
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
  queueChatBackgroundTask('recordToolUseStats', recordToolUseStats(PROJECT_DIR, activeModel, {
    toolCalls: toolCallCount,
    toolSuccesses: toolSuccessCount,
    finalTextResponse: assistantTextBuffer.trim().length > 0,
  }));

  queueChatBackgroundTask('chatLearningRecorder.onSessionEnd', chatLearningRecorder.onSessionEnd().then(({ reflection, newPatterns }) => {
    if (reflection.insights.length > 0) {
      logger.info('Learning', `Session reflection: ${reflection.insights.join('; ')}`);
    }
    if (newPatterns.length > 0) {
      logger.info('Learning', `${newPatterns.length} patterns ready for skill promotion`);
    }
  }));
  queueChatBackgroundTask('persistSessionLearning', persistSessionLearning(session, projectDir));
  queueChatBackgroundTask('webRuntime.rebuildSemanticMemory', webRuntime.rebuildSemanticMemory(projectDir));

  // Build gate (advisory test-and-learn): if this turn wrote source files,
  // run a cheap validation and feed the REAL pass/fail into the readiness
  // score and the learning signal below. Runs before the mycelium block so
  // both consume it. Never blocks the response.
  const gateChangedFiles = evidenceFiles
    .filter((f) => f.action === 'write' || f.action === 'edit')
    .map((f) => f.path);
  const buildGateResult = await runChatBuildGate(PROJECT_DIR, gateChangedFiles);
  const gateFailed = buildGateResult.ran && !buildGateResult.passed;
  if (buildGateResult.ran) {
    res.write(`data: ${JSON.stringify({ type: 'validation_gate', ran: true, passed: buildGateResult.passed, kind: buildGateResult.kind, summary: buildGateResult.summary, checks: buildGateResult.results.map((r) => ({ label: r.label, passed: r.passed })) })}\n\n`);
    emitEvent(PROJECT_DIR, 'system', 'validation_gate', {
      session_id: session.getSessionId(),
      passed: buildGateResult.passed,
      kind: buildGateResult.kind,
      summary: buildGateResult.summary,
      checks: buildGateResult.results.map((r) => ({ label: r.label, passed: r.passed, exitCode: r.exitCode })),
    }, 'agent', session.getSessionId()).catch((err) => recordSwallowed('chat.validationGate', err));
    if (gateFailed) {
      logger.warn('BuildGate', `Validation failed for chat turn: ${buildGateResult.summary}`);
      // The harness already has a real test-and-learn loop that iterates the
      // agent to convergence (runGoalLoop + the 'queryloop' runner, reachable
      // at POST /api/goals/:id/start). When a multi-file build fails its gate,
      // surface that loop as a ready-to-launch fix — advisory only, mirroring
      // escalation_advisory. We never auto-start it: the gate is advisory by
      // design, and auto-iterating spends tokens without the user asking.
      const sourceFileCount = gateChangedFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i.test(f)).length;
      if (sourceFileCount >= 2) {
        res.write(`data: ${JSON.stringify({
          type: 'fix_loop_advisory',
          reason: `Build validation failed (${buildGateResult.summary}). A fix loop can iterate the agent until it passes.`,
          failedChecks: buildGateResult.results.filter((r) => !r.passed).map((r) => r.label),
          goal: {
            target: `Fix the failing build validation: ${buildGateResult.summary}`,
            validation: buildGateResult.results.filter((r) => !r.passed).map((r) => r.label),
          },
          launch: { method: 'POST', path: '/api/goals (create) then /api/goals/:id/start', runner: 'queryloop' },
        })}\n\n`);
        emitEvent(PROJECT_DIR, 'system', 'fix_loop_suggested', {
          session_id: session.getSessionId(),
          summary: buildGateResult.summary,
          failed_checks: buildGateResult.results.filter((r) => !r.passed).map((r) => r.label),
        }, 'agent', session.getSessionId()).catch((err) => recordSwallowed('chat.fixLoopAdvisory', err));
      }
    }
  }

  // Mycelium reinforcement: strengthen or weaken routes based on outcome.
  // Run a heuristic verifier first so the reward reflects safety + tool reliability.
  let nsPainMultiplier = 1.0;
  let myceliumEpisodeId: string | undefined;
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
      } catch (err) { recordSwallowed('chat.heuristicVerifier', err); }
    }
    // Nervous System: inspect verifier result and extract pain
    const nervousVerifier = chatNervousSystem.onVerifierResult(
      verifierBlocked ? 'fail' : 'pass',
      verifierScore,
      verifierBlocked && verifierBlockReason ? [verifierBlockReason] : undefined,
    );
    const nsPainResult = nervousVerifier.painMultiplier;
    nsPainMultiplier = nsPainResult;

    // A failed build gate is strong evidence the turn's code does not work,
    // even when the model produced confident prose. Pull the reward down so the
    // router learns from execution, not just from emitting output.
    const gateRewardFactor = gateFailed ? 0.4 : 1.0;

    // Per-(model, taskType) reliability: record whether this turn produced a
    // usable result so the readiness gate can supply a real model_reliability
    // signal on future turns. Historical-only; this turn already read priors.
    queueChatBackgroundTask('recordModelOutcome', recordModelOutcome(
      PROJECT_DIR,
      activeModel,
      myceliumClassification?.type ?? 'general',
      hasOutput && !verifierBlocked && !gateFailed,
    ));

    myceliumRouter.reinforce({
      taskSuccess: (hasOutput ? 0.7 : 0.2) * nsPainMultiplier * gateRewardFactor,
      correctness: (hasOutput ? 0.6 + toolSuccessRate * 0.3 : 0.1) * nsPainMultiplier * gateRewardFactor,
      usefulness: (hasOutput ? 0.5 + toolSuccessRate * 0.3 : 0.1) * nsPainMultiplier,
      costEfficiency: toolCallCount <= 5 ? 0.8 : toolCallCount <= 15 ? 0.5 : 0.2,
      userSatisfaction: verifierScore * nsPainMultiplier * gateRewardFactor,
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
    // Bind this turn's recorded episode id so a later thumbs vote attaches to
    // exactly this route, not whatever episode is most recent at vote time.
    // Also append the reward to the durable ledger so the learning curve
    // (is the system improving?) can be computed from real history.
    if (myceliumRouter.getLastRoute().length > 0) {
      const recordedEpisode = graph.listEpisodes(1)[0];
      myceliumEpisodeId = recordedEpisode?.id;
      if (recordedEpisode) {
        queueChatBackgroundTask('appendRewardEntry', appendRewardEntry(PROJECT_DIR, {
          ts: recordedEpisode.timestamp,
          taskType: recordedEpisode.taskType,
          reward: recordedEpisode.reward,
          components: recordedEpisode.rewardComponents,
          model: activeModel,
          gatePassed: buildGateResult.ran ? buildGateResult.passed : undefined,
        }));
      }
    }
  }

  // Persist nervous system signals for historical analysis, then snapshot
  // the run into the module-level mirror so /api/nervous shows the last
  // completed chat’s state.
  chatNervousSystem.persistSignals(PROJECT_DIR).catch((err) => recordSwallowed('chatNervousSystem.persistSignals', err));
  lastNervousSnapshot = {
    summary: chatNervousSystem.getSummary(),
    signals: chatNervousSystem.getSignals(),
    recovery: chatNervousSystem.getRecoveryPlan(),
    runState: chatNervousSystem.getRunState(),
  };

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
      episodeId: myceliumEpisodeId,
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
  // Honest, auditable provenance for the run: which model produced it, when,
  // and from what sources. Derived from the just-built evidence card so it
  // never fabricates a model/time and marks sources proven only on evidence.
  res.write(`data: ${JSON.stringify({ type: 'run_provenance', ...buildRunProvenance(evidenceCard) })}\n\n`);
  // Honest offline guarantee: paints an 'offline' badge ONLY when the run's
  // model was provably local AND no network-category tool was used. A cloud
  // model or network tool proves 'online'; an unrecorded locality or an
  // unresolvable tool category yields 'unknown' rather than a false claim.
  {
    const offlineRegistry = createToolRegistry(PROJECT_DIR);
    const offlineToolRefs = evidenceCard.tools.map((t) => ({
      name: t.name,
      category: offlineRegistry.get(t.name)?.permissionCategory,
    }));
    res.write(`data: ${JSON.stringify({ type: 'offline', ...assessOfflineGuarantee({ modelLocality: runLocality, tools: offlineToolRefs }) })}\n\n`);
  }

  // Promise detection: scan assistant output for commitment language and auto-record promises.
  if (assistantTextBuffer.trim()) {
    const commitments = detectCommitments(assistantTextBuffer);
    for (const commitment of commitments) {
      createPromise(PROJECT_DIR, commitment, { session_id: session.getSessionId() })
        .then((p) => {
          emitEvent(PROJECT_DIR, 'promise', 'promise_auto_detected', { promise_id: p.promise_id, commitment }, 'agent', p.promise_id).catch((err) => recordSwallowed('emitEvent', err));
          logger.info('Promises', `Auto-detected commitment: ${commitment.slice(0, 80)}`);
        })
        .catch((err) => recordSwallowed('server.ts:6719', err));
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
        }, 'agent', session.getSessionId()).catch((err) => recordSwallowed('server.ts:6735', err));
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
  }, 'agent', session.getSessionId()).catch((err) => recordSwallowed('server.ts:6748', err));

  // Execution Readiness Gate: compute and emit readiness score for this turn.
  // Reliability is historical (prior turns); this turn's outcome is recorded
  // asynchronously above and feeds future turns.
  const readinessReliability = await loadModelReliability(PROJECT_DIR);
  const readinessTaskType = myceliumClassification?.type ?? 'general';
  const readinessInput: ReadinessInput = {
    // Output-validation score is genuinely a schema/output-validity signal, so
    // it feeds schema_validity (its true home) rather than double-counting as
    // model_confidence, which we have no honest source for.
    schema_validity: lastValidationScore !== undefined ? lastValidationScore : undefined,
    // Prefer the build gate's real execution result when it ran (ground truth:
    // did the code the agent wrote actually compile/import/test?). Fall back to
    // the nervous-system pain proxy only when no validation was run this turn.
    verifier_score: buildGateVerifierScore(buildGateResult) ?? (typeof nsPainMultiplier === 'number' ? Math.max(0, 1 - (1 - nsPainMultiplier)) : undefined),
    ambiguity_score: myceliumClassification
      ? (myceliumClassification.matchedKeywords.length > 0 ? 0.2 : 0.6)
      : undefined,
    risk_score: myceliumClassification?.highRisk ? 0.8 : 0.2,
    model_reliability: modelReliabilityScore(readinessReliability, activeModel, readinessTaskType),
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
        emitEvent(PROJECT_DIR, 'model', 'escalation_suggested', { current: activeModel, suggested, readiness_score: readiness.score }, 'system').catch((err) => recordSwallowed('emitEvent', err));
        // When the opt-in policy enables auto-escalation and the client passed a
        // sessionId, queue the stronger model so the NEXT turn in this session
        // runs on it. Default-off: advisory-only otherwise.
        if (modelRouting.autoEscalateOnLowReadiness && sessionIdHint) {
          pendingReadinessEscalations.set(sessionIdHint, suggested);
          emitEvent(PROJECT_DIR, 'model', 'escalation_queued', { current: activeModel, queued: suggested, readiness_score: readiness.score, sessionId: sessionIdHint }, 'system').catch((err) => recordSwallowed('emitEvent', err));
        }
      }
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// --- API: Sessions, Recovery, Forking, Semantic Recall ---
// All /api/sessions/* routes moved to ./sessionRoutes.ts (see the
// createSessionRouter mount near the other extracted routers).

// Runs view: same source as /api/sessions but enriched with derived fields
// (duration, age) the dashboard renders without per-row computation.
// Extracted to ./runsRoutes.ts. server.ts still imports SessionStorage +
// readRunEvidence for many other callers (chat handler, jarvis brief, etc).
app.use(createRunsRouter({ projectDir: PROJECT_DIR }));

// Learning console routes — read evolved prompts/reflections/candidates and
// apply routing calibration. Extracted to ./learningRoutes.ts. Mutable
// modelRouting state is bridged via callable deps so server.ts stays the
// single owner of policy persistence (used by /api/settings + boot load).
app.use(createLearningRouter({
  projectDir: PROJECT_DIR,
  getModelRouting: () => modelRouting,
  applyRoutingCalibration: async (suggestedPolicy) => {
    await ensureSettingsLoaded();
    modelRouting = sanitizeModelRoutingPolicy({ ...modelRouting, ...suggestedPolicy });
    await saveSettingsToDisk();
    return getCurrentSettings();
  },
}));

// --- API: Snapshots (skills, memory, config) ---
// Routes extracted to ./snapshotRoutes.ts. server.ts still imports
// snapshots for the pre-recovery snapshot call in the chat handler.
app.use(createSnapshotRouter({ projectDir: PROJECT_DIR }));

// --- API: Local RAG indexes ---
// Routes extracted to ./ragRoutes.ts. server.ts keeps `ragIndex` for
// listIndexes() in the system-overview/registry paths.
app.use(createRagRouter({ projectDir: PROJECT_DIR, getOllamaHost: () => ollamaHost }));

// MCP runtime + catalog routes \u2014 extracted to ./mcpRoutes.ts. Mutable
// capabilityGrants + killSwitchActive bridged via read-only callables;
// ensureSettingsLoaded passed in so the start route still hydrates settings
// before evaluating capability grants.
app.use(createMcpRouter({
  projectDir: PROJECT_DIR,
  getCapabilityGrants: () => capabilityGrants,
  isKillSwitchActive: () => killSwitchActive,
  ensureSettingsLoaded,
}));

// MCP routes moved to ./mcpRoutes.ts (createMcpRouter mount above).

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
// Routes extracted to ./historyRoutes.ts. server.ts keeps HISTORY_DIR
// const for the system-overview report (line 10391).
app.use(createHistoryRouter({ projectDir: PROJECT_DIR }));

// --- API: Skills ---
// 13 routes extracted to ./skillRoutes.ts. server.ts keeps SKILLS_DIR /
// REPO_SKILLS_DIR / GLOBAL_SKILLS_DIR + skillFolderId/mapSkillForApi/
// skillSourceForApi here because /api/system-overview also surfaces the
// skill source list. The router duplicates those three small helpers; the
// skill-authoring primitives (buildRuntimeSkillFile + sanitizeSkill* +
// snapshotSkillHistory) live in ../extensibility/skillAuthoring and are
// shared with the create_skill tool so both paths meet the same bar.
app.use(createSkillRouter({
  projectDir: PROJECT_DIR,
  skillsDir: SKILLS_DIR,
  repoSkillsDir: REPO_SKILLS_DIR,
  globalSkillsDir: GLOBAL_SKILLS_DIR,
}));

// --- API: Curator ---
// 7 /api/curator* routes moved to ./curatorRoutes.ts. server.ts retains
// curatorSettings/lastUserActivityMs/curatorScheduler mutables + the
// curatorConfigFromSettings/curatorDeps helpers (still used by the
// curator scheduler wired in at line ~1101) and bridges them via three
// thick callables.
app.use(createCuratorRouter({
  projectDir: PROJECT_DIR,
  getCuratorStatus: async () => {
    const log = await readCuratorLog(PROJECT_DIR, 50);
    const proposals = await readCuratorProposals(PROJECT_DIR);
    let archived: string[] = [];
    try {
      const archiveDir = path.join(SKILLS_DIR, '_archive');
      const entries = await fs.readdir(archiveDir, { withFileTypes: true });
      archived = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch { /* archive dir does not exist yet */ }
    return {
      settings: curatorSettings,
      lastUserActivityAt: new Date(lastUserActivityMs).toISOString(),
      schedulerRunning: Boolean(curatorScheduler),
      log,
      proposals,
      archived,
    };
  },
  runCuratorPreview: async () => {
    return runDeterministicPhase(PROJECT_DIR, curatorConfigFromSettings(), curatorDeps(), { dryRun: true });
  },
  runCuratorPhase: async () => {
    const summary = await runCurator(PROJECT_DIR, curatorConfigFromSettings(), curatorDeps());
    if (!summary.dryRun) {
      curatorSettings = { ...curatorSettings, lastRunAt: new Date().toISOString() };
      await saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
    }
    return summary;
  },
}));

// --- API: Agent Memory ---
// Moved to ./memoryRoutes.ts (createMemoryRouter mount above).

// Learning routes moved to ./learningRoutes.ts (createLearningRouter mount above).

// --- API: File Upload ---
app.post('/api/upload', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const filename = req.headers['x-filename'] as string;
  if (!filename) { res.status(400).json({ error: 'x-filename header required' }); return; }

  // Sanitize filename — strip path traversal
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe) { res.status(400).json({ error: 'Invalid filename' }); return; }
  const mimeType = req.headers['content-type']?.toString() || 'application/octet-stream';
  const mediaKind = inferMediaKind(safe, mimeType);
  if (mediaKind === 'other') {
    res.status(415).json({ error: 'Unsupported upload type. Allowed kinds: image, audio, pdf, text, data, document.' });
    return;
  }

  try {
    const uploadsDir = getUploadsDir();
    await fs.mkdir(uploadsDir, { recursive: true });
    const dest = path.join(uploadsDir, safe);
    await fs.writeFile(dest, req.body);
    logger.info('Upload', `File saved: ${safe} (${req.body.length} bytes)`);
    res.json({ path: dest, name: safe, size: req.body.length, mimeType, mediaKind });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

function inferMediaKind(fileName: string, mimeType: string): 'image' | 'audio' | 'pdf' | 'text' | 'data' | 'document' | 'other' {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lowerName)) return 'image';
  if (lowerMime.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|opus)$/.test(lowerName)) return 'audio';
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) return 'pdf';
  if (/\.(docx|xlsx|pptx)$/.test(lowerName)) return 'document';
  if (lowerMime.startsWith('text/') || /\.(txt|md|csv|json|log|ts|js|py|cs|rs|html|css)$/.test(lowerName)) return 'text';
  if (/\.(jsonl|xml|yaml|yml|parquet|sqlite|db)$/.test(lowerName)) return 'data';
  return 'other';
}

// --- API: Save chat output to agent-outputs/ ---
// ─── Save chat reply / output ───────────────────────────────────────────────
// POST /api/save-output — writes a chat reply (or arbitrary text) to the
// agent-outputs/ corral. Basename-only path resolution, never overwrites
// existing files (auto-suffixes -2, -3, …), 1 MB cap. Helper fileExists +
// the getAgentOutputDir import moved into ./saveOutputRoutes.ts.
app.use(createSaveOutputRouter({ projectDir: PROJECT_DIR }));

// Uploads listing / delete / manual cleanup. pruneUploads stays in server.ts
// because the auto-prune timer also calls it; router invokes it via a
// callable dep.
app.use(createUploadsRouter({ getUploadsDir, pruneUploads }));

// Uploads routes moved to ./uploadsRoutes.ts (createUploadsRouter mount above).

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
  await saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
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
  schedulerRegistry.unregister('uploads-auto-prune');
  if (mediaTools.uploadsAutoPruneDays <= 0) return;
  uploadsAutoPruneTimer = setInterval(() => {
    pruneUploads(mediaTools.uploadsAutoPruneDays).catch((error) => {
      logger.warn('Uploads', 'Scheduled auto-prune failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }, UPLOADS_AUTO_PRUNE_INTERVAL_MS);
  if (typeof uploadsAutoPruneTimer.unref === 'function') uploadsAutoPruneTimer.unref();
  schedulerRegistry.register({
    name: 'uploads-auto-prune',
    stop: () => stopUploadsAutoPrune(),
    isRunning: () => uploadsAutoPruneTimer !== null,
    restart: () => configureUploadsAutoPrune(),
  });
}

export function stopUploadsAutoPrune(): void {
  if (uploadsAutoPruneTimer) {
    clearInterval(uploadsAutoPruneTimer);
    uploadsAutoPruneTimer = null;
  }
  schedulerRegistry.unregister('uploads-auto-prune');
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
    isKillSwitchActive: () => killSwitch.isActive(),
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
  schedulerRegistry.unregister('curator');
  if (!curatorSettings.enabled) return;
  curatorScheduler = new CuratorScheduler({
    projectDir: PROJECT_DIR,
    config: curatorConfigFromSettings(),
    intervalHours: curatorSettings.intervalHours,
    idleThresholdMinutes: curatorSettings.idleThresholdMinutes,
    isKillSwitchActive: () => killSwitch.isActive(),
    isEnabled: () => curatorSettings.enabled,
    getLastUserActivityMs: () => lastUserActivityMs,
    getLastRunMs: () => curatorSettings.lastRunAt ? Date.parse(curatorSettings.lastRunAt) || 0 : 0,
    recordRunMs: (timestamp) => {
      curatorSettings = { ...curatorSettings, lastRunAt: new Date(timestamp).toISOString() };
      saveSettingsToDisk().catch((err) => recordSwallowed('saveSettingsToDisk', err));
    },
    callModel: curatorDeps().callModel,
    // Candidate-pressure accelerator: when ≥25 unreviewed candidates have
    // accumulated, run the curator the next time the system is idle even
    // if the long interval (default 168h) has not elapsed. Keeps the
    // promotion loop from going stale on busy days. Reads listed are
    // already cheap because the file is JSONL.
    runWhenCandidatesAtLeast: 25,
    getPendingCandidateCount: async () => {
      // listReviewedLearningCandidates already merges candidates with their
      // latest review and tags each one with reviewStatus. Anything still
      // 'pending' counts toward candidate pressure.
      const reviewed = await listReviewedLearningCandidates(PROJECT_DIR, 200).catch(() => []);
      return reviewed.filter((candidate) => candidate.reviewStatus === 'pending').length;
    },
  });
  curatorScheduler.start();
  schedulerRegistry.register({
    name: 'curator',
    stop: () => stopCuratorScheduler(),
    isRunning: () => curatorScheduler !== null,
    restart: () => configureCuratorScheduler(),
  });
}

export function stopCuratorScheduler(): void {
  if (curatorScheduler) {
    curatorScheduler.stop();
    curatorScheduler = null;
  }
  schedulerRegistry.unregister('curator');
}

// Adaptive identity scheduler. Always-on once started: per-tick behaviour
// is governed by the on-disk auto-update.json config (default: both flags
// off, so the tick is a no-op model-call-free read). Kill switch wins.
function configureIdentityAutoUpdateScheduler(): void {
  if (identityAutoUpdateScheduler) {
    identityAutoUpdateScheduler.stop();
    identityAutoUpdateScheduler = null;
  }
  schedulerRegistry.unregister('identity-auto-update');
  identityAutoUpdateScheduler = new IdentityAutoUpdateScheduler({
    projectDir: PROJECT_DIR,
    callModel: curatorDeps().callModel,
    getLastUserActivityMs: () => lastUserActivityMs,
    isEnabled: () => !killSwitch.isActive(),
  });
  identityAutoUpdateScheduler.start();
  schedulerRegistry.register({
    name: 'identity-auto-update',
    stop: () => stopIdentityAutoUpdateScheduler(),
    isRunning: () => identityAutoUpdateScheduler !== null,
    restart: () => configureIdentityAutoUpdateScheduler(),
  });
}

export function stopIdentityAutoUpdateScheduler(): void {
  if (identityAutoUpdateScheduler) {
    identityAutoUpdateScheduler.stop();
    identityAutoUpdateScheduler = null;
  }
  schedulerRegistry.unregister('identity-auto-update');
}

function heartbeatEnabled(): boolean {
  const fromEnv = readEnvFlag('HARNESS_HEARTBEAT_ENABLED');
  if (fromEnv !== undefined) return fromEnv;
  if (systemFeatureFlags.heartbeatEnabled === true) return true;
  return proactiveProfileEnabled();
}

function configureSelfLearningHeartbeat(): void {
  if (selfLearningHeartbeat) {
    selfLearningHeartbeat.stop();
    selfLearningHeartbeat = null;
  }
  schedulerRegistry.unregister('self-learning-heartbeat');
  if (!heartbeatEnabled()) return;
  const intervalMinutes = Number(process.env.HARNESS_HEARTBEAT_INTERVAL_MIN ?? '15') || 15;
  // Default action set plus a work_assigned_tasks action that delegates to
  // the assigned sub-agent via runSubagent. The runner reuses the same
  // chat-client + tool snapshot the chat path uses so behaviour stays
  // consistent with interactive runs.
  const actions = defaultHeartbeatActions();
  actions.push(createIdentityGcAction({}));
  // Prune stale agent-outputs/ scratch files. On by default with a
  // 14-day cutoff because old reports otherwise pollute later grep
  // searches with off-topic results (the VW report leaking into a
  // trading session, for example). Set HARNESS_HEARTBEAT_CLEANUP_OUTPUTS=0
  // to disable. HARNESS_AGENT_OUTPUT_MAX_AGE_DAYS overrides the cutoff.
  if (process.env.HARNESS_HEARTBEAT_CLEANUP_OUTPUTS !== '0') {
    const maxAgeDays = Number(process.env.HARNESS_AGENT_OUTPUT_MAX_AGE_DAYS ?? '14') || 14;
    actions.push(createCleanupAgentOutputsAction({ maxAgeDays }));
  }
  // Optional learning-flavoured actions, off by default. Both are
  // deterministic / read-only — no LLM calls — so they are safe to enable.
  if (process.env.HARNESS_HEARTBEAT_REFLECT_ENABLED === '1') {
    actions.push(createReflectAndLearnAction());
  }
  if (process.env.HARNESS_HEARTBEAT_SKILL_EVOLUTION_ENABLED === '1') {
    actions.push(createSkillEvolutionAction({}));
  }
  actions.push(createWorkAssignedTasksAction({
    knownAgentIds: async () => {
      const customs = await loadAgentDefinitions(PROJECT_DIR).catch(() => []);
      return new Set([
        ...BUILTIN_AGENT_ROLES.map((agent) => agent.id),
        ...customs.map((agent) => agent.id),
      ]);
    },
    runner: async ({ task, agentId }) => {
      const { runSubagent } = await import('../agents/subagent');
      const customAgents = await loadAgentDefinitions(PROJECT_DIR).catch(() => []);
      const parentClient = webRuntime.createClient(currentModel || 'llama3.1:8b', ollamaHost);
      const baseTools = applyToolDisables(getRuntimeTools(PROJECT_DIR)).filter((tool) => tool.name !== 'agent');
      return runSubagent(
        { name: agentId, systemPrompt: '', agentId, customAgents },
        `${task.title}${task.description ? `\n\n${task.description}` : ''}`,
        parentClient,
        baseTools,
      );
    },
  }));
  selfLearningHeartbeat = new SelfLearningHeartbeat({
    projectDir: PROJECT_DIR,
    intervalMinutes,
    actions,
    isKillSwitchActive: () => killSwitch.isActive(),
    isEnabled: () => heartbeatEnabled() && !killSwitch.isActive(),
    getLastRunMs: () => heartbeatLastRunMs,
    recordRunMs: (timestamp) => { heartbeatLastRunMs = timestamp; },
  });
  selfLearningHeartbeat.start();
  schedulerRegistry.register({
    name: 'self-learning-heartbeat',
    stop: () => stopSelfLearningHeartbeat(),
    isRunning: () => selfLearningHeartbeat !== null,
    restart: () => configureSelfLearningHeartbeat(),
  });
}

export function stopSelfLearningHeartbeat(): void {
  if (selfLearningHeartbeat) {
    selfLearningHeartbeat.stop();
    selfLearningHeartbeat = null;
  }
  schedulerRegistry.unregister('self-learning-heartbeat');
}

function triggersEnabled(): boolean {
  const fromEnv = readEnvFlag('HARNESS_TRIGGERS_ENABLED');
  if (fromEnv !== undefined) return fromEnv;
  if (systemFeatureFlags.triggersEnabled === true) return true;
  return proactiveProfileEnabled();
}

function configureTriggerScheduler(): void {
  if (triggerScheduler) {
    triggerScheduler.stop();
    triggerScheduler = null;
  }
  schedulerRegistry.unregister('triggers');
  if (!triggersEnabled()) return;
  triggerScheduler = new TriggerScheduler({
    projectDir: PROJECT_DIR,
    isKillSwitchActive: () => killSwitch.isActive(),
    isEnabled: () => triggersEnabled() && !killSwitch.isActive(),
  });
  triggerScheduler.start();
  schedulerRegistry.register({
    name: 'triggers',
    stop: () => stopTriggerScheduler(),
    isRunning: () => triggerScheduler !== null,
    restart: () => configureTriggerScheduler(),
  });
}

export function stopTriggerScheduler(): void {
  if (triggerScheduler) {
    triggerScheduler.stop();
    triggerScheduler = null;
  }
  schedulerRegistry.unregister('triggers');
}

// ─── OTLP / OpenInference trace export ─────────────────────────────
// Optional fan-out from the in-process RuntimeTracer to an OTLP/HTTP
// collector (Phoenix, Laminar, Langfuse, OTel Collector). Uses a tiny
// JSON-encoded HTTP exporter — no @opentelemetry/* runtime deps.
let otlpExporterHandle: { exporter: OtlpExporter; detach: () => Promise<void> } | null = null;

function otelExportEnabled(): boolean {
  return resolveFeatureFlag('HARNESS_OTEL_EXPORT_ENABLED', 'otelExportEnabled');
}

function configureOtlpExporter(): void {
  // Detach any prior exporter so flag toggles are clean.
  if (otlpExporterHandle) {
    otlpExporterHandle.detach().catch(() => { /* best-effort */ });
    otlpExporterHandle = null;
  }
  schedulerRegistry.unregister('otlp-exporter');
  if (!otelExportEnabled()) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) {
    logger.warn('Observability', 'HARNESS_OTEL_EXPORT_ENABLED is set but OTEL_EXPORTER_OTLP_ENDPOINT is empty; OTLP export inactive');
    return;
  }
  const traceIdHex = mintTraceId(`${process.pid}-${Date.now()}`);
  otlpExporterHandle = attachOtlpExporter(runtimeTracer, {
    endpoint,
    authorization: process.env.OTEL_EXPORTER_OTLP_HEADERS?.split('=').slice(1).join('=') || undefined,
    traceIdHex,
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'harness',
    serviceVersion: '1',
    logger: { warn: (message, meta) => logger.warn('Observability', message, meta ?? {}) },
  });
  logger.info('Observability', 'OTLP exporter attached', { endpoint });
  schedulerRegistry.register({
    name: 'otlp-exporter',
    stop: () => stopOtlpExporter(),
    isRunning: () => otlpExporterHandle !== null,
    restart: () => configureOtlpExporter(),
  });
}

export function stopOtlpExporter(): Promise<void> {
  schedulerRegistry.unregister('otlp-exporter');
  if (!otlpExporterHandle) return Promise.resolve();
  const handle = otlpExporterHandle;
  otlpExporterHandle = null;
  return handle.detach();
}

function configureAutomationScheduler(): void {
  if (automationScheduler) {
    automationScheduler.stop();
    automationScheduler = null;
  }
  schedulerRegistry.unregister('automation');
  if (!automationSchedulerSettings.enabled) return;
  automationScheduler = new AutomationScheduler({
    projectDir: PROJECT_DIR,
    getPolicyContext: () => getAutomationPolicyContext(),
    isKillSwitchActive: () => killSwitch.isActive(),
    isEnabled: () => automationSchedulerSettings.enabled && !killSwitch.isActive(),
    getLastUserActivityMs: () => lastUserActivityMs,
    idleThresholdMinutes: automationSchedulerSettings.idleThresholdMinutes,
    onBreachDetected: (breaches) => {
      const msg = `⚠️ ${breaches.length} promise breach(es):\n${breaches.map((b) => `• ${b.breach_type}: ${b.detail.slice(0, 100)}`).join('\n')}`;
      sendTelegramNotification('Promise breach', msg).catch((err) => recordSwallowed('sendTelegramNotification', err));
      sendWebhookNotification('promise.breach', { breaches }).catch((err) => recordSwallowed('sendWebhookNotification', err));
    },
    // While the user is away, re-investigate any drained needs-review answers
    // and re-enqueue the results for human review. Auto-approves nothing —
    // replayed answers re-enter the same human-gated queue (shadow-first).
    onIdle: () => {
      runReplayCandidates({ runOne: runReplayQuery })
        .then((r) => {
          if (r.consumed > 0) {
            logger.info('Governed', 'Idle replay completed', { ...r });
            // Persist an audit trail so a human can see what the loop did unattended.
            appendReplayLedgerEntry({ at: new Date().toISOString(), ...r }).catch((err) => recordSwallowed('scheduler.idleReplayLedger', err));
          }
        })
        .catch((err) => recordSwallowed('scheduler.idleReplay', err));
    },
  });
  automationScheduler.start();
  schedulerRegistry.register({
    name: 'automation',
    stop: () => stopAutomationScheduler(),
    isRunning: () => automationScheduler !== null,
    restart: () => configureAutomationScheduler(),
  });
}

export function stopAutomationScheduler(): void {
  if (automationScheduler) {
    automationScheduler.stop();
    automationScheduler = null;
  }
  schedulerRegistry.unregister('automation');
}

// ─── Teammate Scheduler ───────────────────────────────────────────────────
// Lazily creates / restarts the Teammate scheduler so changes to the
// dailyBrief settings block take effect without a server restart. The
// scheduler is a no-op when settings.enabled is false; we still keep the
// instance alive so manual `runNow` calls work from the API.

// Runs a briefing prompt through the model on a NON-INTERACTIVE path: only the
// read-only web tools are exposed and every call is auto-allowed, so an
// unattended scheduled run never blocks on a permission prompt. Returns the
// model's accumulated text.
async function runBriefingChat(prompt: string): Promise<string> {
  const model = currentModel || 'llama3.1:8b';
  const client = webRuntime.createClient(model, ollamaHost);
  const webTools = webRuntime.getTools().filter((t) => t.name === 'web_search' || t.name === 'web_read');
  const config: LoopConfig = {
    model,
    systemPrompt: 'You are a concise briefing assistant. Use the web tools to gather current facts. Never fabricate weather, news, or other facts you have not looked up.',
    maxTurns: 6,
    maxTimeMs: 120_000,
  };
  const deps: QueryLoopDeps = {
    client,
    tools: webTools,
    permissionCheck: async () => ({ allowed: true }),
  };
  let text = '';
  for await (const event of webRuntime.runQueryLoop(config, deps, [{ role: 'user', content: prompt }])) {
    if (event.type === 'text') text += event.content;
  }
  return text.trim();
}

// Re-asks a single drained needs-review answer through the harness on the same
// non-interactive, read-only-web path as the briefing runner, and returns the
// governed shadow answer if governance is enabled (else null). Auto-approves
// nothing — the caller re-enqueues the result for human review.
async function runReplayQuery(candidate: ReplayCandidate): Promise<GovernedAnswer | null> {
  const model = currentModel || 'llama3.1:8b';
  const client = webRuntime.createClient(model, ollamaHost);
  const webTools = webRuntime.getTools().filter((t) => t.name === 'web_search' || t.name === 'web_read');
  const config: LoopConfig = {
    model,
    systemPrompt: 'You are re-investigating a previously low-confidence answer. Use the web tools to verify or correct it. Never fabricate facts you have not looked up.',
    maxTurns: 6,
    maxTimeMs: 120_000,
  };
  const deps: QueryLoopDeps = {
    client,
    tools: webTools,
    permissionCheck: async () => ({ allowed: true }),
  };
  const prompt = `Re-investigate and verify this claim, correcting it if it is wrong:\n\n${candidate.content}`;
  let governed: GovernedAnswer | null = null;
  for await (const event of webRuntime.runQueryLoop(config, deps, [{ role: 'user', content: prompt }])) {
    if (event.type === 'governed_shadow') governed = event.governed;
  }
  return governed;
}

// Best-effort calendar source for the briefing: reads a local .ics file and
// maps it to lightweight events. Throws are caught upstream by the briefing
// builder, which then simply omits the agenda.
async function loadCalendarEventsFromPath(rawPath: string, projectDir: string): Promise<BriefingCalendarEvent[]> {
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectDir, rawPath);
  if (!filePath.toLowerCase().endsWith('.ics')) return [];
  const content = await fs.readFile(filePath, 'utf-8');
  return parseIcsEvents(content).map((e) => ({
    start: new Date(e.start),
    summary: e.summary,
    location: e.location,
  }));
}

function configureTeammateScheduler(): void {
  if (teammateScheduler) {
    teammateScheduler.stop();
    teammateScheduler = null;
  }
  schedulerRegistry.unregister('teammate');
  teammateScheduler = new TeammateScheduler({
    projectDir: PROJECT_DIR,
    getSettings: () => teammateSettings,
    updateSettings: async (next) => {
      teammateSettings = next;
      await saveSettingsToDisk().catch((err) => recordSwallowed('teammate.saveSettings', err));
    },
    // Per-run snapshot producer. When a custom briefing prompt is configured,
    // run it through the model + web search; otherwise fall back to the default
    // activity brief. Read live settings so config changes take effect per run.
    snapshot: async (dir) => {
      const s = teammateSettings;
      const prompt = (s.briefingPrompt ?? '').trim();
      if (!prompt) {
        return snapshotDailyBrief({ projectDir: dir, ambientSignals: jarvisAmbientBus.recent(), windowDescription: 'scheduled' });
      }
      const calendarPath = (s.calendarPath ?? '').trim();
      return buildMorningBriefing({
        prompt,
        maxWords: s.briefingMaxWords,
        runChat: runBriefingChat,
        calendar: calendarPath ? () => loadCalendarEventsFromPath(calendarPath, dir) : undefined,
      });
    },
    delivery: {
      sendTelegram: async (markdown) => {
        await sendTelegramNotification('Daily brief', markdown);
      },
      sendDiscord: async (markdown) => {
        await sendWebhookNotification('teammate.brief', { channel: 'discord', markdown });
      },
      sendSlack: async (markdown) => {
        await sendWebhookNotification('teammate.brief', { channel: 'slack', markdown });
      },
    },
    isHalted: () => killSwitch.isActive(),
  });
  if (teammateSettings.enabled) teammateScheduler.start();
  schedulerRegistry.register({
    name: 'teammate',
    stop: () => stopTeammateScheduler(),
    isRunning: () => teammateScheduler !== null,
    restart: () => configureTeammateScheduler(),
  });
  // Refresh nextRunAt so the UI's status card is accurate even before the
  // first tick fires.
  const nextRunAt = teammateScheduler.computeNextRunAt();
  if (nextRunAt !== teammateSettings.nextRunAt) {
    teammateSettings = { ...teammateSettings, nextRunAt };
    saveSettingsToDisk().catch((err) => recordSwallowed('teammate.refreshNextRunAt', err));
  }
}

export function stopTeammateScheduler(): void {
  if (teammateScheduler) {
    teammateScheduler.stop();
    teammateScheduler = null;
  }
  schedulerRegistry.unregister('teammate');
}

// Teammate routes moved to ./teammateRoutes.ts (createTeammateRouter mount below).
app.use(createTeammateRouter({
  getStatus: () => ({
    settings: teammateSettings,
    nextRunAt: teammateScheduler ? teammateScheduler.computeNextRunAt() : '',
    schedulerRunning: teammateScheduler !== null && teammateSettings.enabled,
    telegramConfigured: Boolean((telegramBotToken || process.env.HARNESS_TELEGRAM_BOT_TOKEN || '').trim()),
    discordConfigured: Boolean((connectorSecretValue('HARNESS_DISCORD_BOT_TOKEN') || '').trim()),
    slackConfigured: Boolean((connectorSecretValue('HARNESS_SLACK_WEBHOOK_URL') || '').trim()),
  }),
  applyTeammateConfig: async (body) => {
    const next = sanitizeTeammateSettings(body);
    teammateSettings = next;
    configureTeammateScheduler();
    await saveSettingsToDisk();
    return { settings: teammateSettings, nextRunAt: teammateScheduler ? teammateScheduler.computeNextRunAt() : '' };
  },
  runTeammateNow: async () => {
    if (!teammateScheduler) configureTeammateScheduler();
    return teammateScheduler!.runNow();
  },
  isKillSwitchActive: () => killSwitch.isActive(),
}));

/**
 * Stop every registered scheduler in reverse-registration order. Intended
 * for shutdown / test teardown — callers that only need to stop one
 * subsystem should keep using the individual `stopX` exports.
 */
export async function stopAllSchedulers(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  return schedulerRegistry.stopAll();
}

/** Diagnostic snapshot of currently-registered scheduler liveness. */
export function getSchedulerStatuses(): Array<{ name: string; running: boolean }> {
  return schedulerRegistry.list();
}

// ─── File / Directory Browse ────────────────────────────────────────
// /api/files (project-confined file tree) + /api/browse-dirs (free-roam
// directory picker for agent_outputs folder selection). Extracted to
// ./fileBrowseRoutes.ts; resolveProjectPath helper moved into router
// (it had no other callers in server.ts).
app.use(createFileBrowseRouter({ projectDir: PROJECT_DIR }));

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

interface ChatModelRoutingDecision {
  model: string;
  routed: boolean;
  tier?: string;
  taskType?: string;
  risk?: string;
  from?: string;
  reason?: string;
  reasons?: string[];
}

const PREFERRED_AGENTIC_FALLBACK_MODELS = [
  'gpt-oss:20b-cloud',
  'gpt-oss:120b-cloud',
  'qwen2.5-coder:14b',
  'deepseek-v3.1:671b-cloud',
  'qwen3-coder:480b-cloud',
  'glm-5.1:cloud',
];

export async function resolveChatModelForRequest(requestedModel: string, messageText: string): Promise<ChatModelRoutingDecision> {
  const available = await webRuntime.listModels(ollamaHost).catch(() => []);
  const candidates = buildChatModelCandidatePool(requestedModel, available, modelRouting);
  return selectModelForChatTurn({
    requestedModel,
    message: messageText,
    candidates,
    requestedModelWeak: isKnownWeakAgenticModel(requestedModel),
  }, modelRouting);
}

function isKnownWeakAgenticModel(modelName: string): boolean {
  return /^gemma4:(e4b|26b)$/i.test(modelName.trim());
}

function buildChatModelCandidatePool(requestedModel: string, availableModels: string[], policy: ModelRoutingPolicy = {}): ChatModelCandidatePool {
  const localAgentic = preferredLocalAgenticModels(requestedModel, availableModels, policy);
  const available = new Set(availableModels.map((name) => name.toLowerCase()));
  return {
    small: firstConfiguredChatModel([
      policyChatModel(policy.smallModel, available),
      providerModel('openrouter', 'openai/gpt-5-mini'),
      providerModel('openrouter', 'meta-llama/llama-3.3-70b-instruct:free'),
      providerModel('gemini', 'gemini-2.0-flash-lite'),
    ]),
    default: firstConfiguredChatModel([
      policyChatModel(policy.defaultModel, available),
      providerModel('openrouter', 'google/gemini-2.5-flash'),
      providerModel('gemini', 'gemini-2.5-flash'),
      providerModel('openai', 'gpt-4o-mini'),
      ...localAgentic,
    ]),
    strong: firstConfiguredChatModel([
      policyChatModel(policy.strongModel, available),
      providerModel('openrouter', 'anthropic/claude-sonnet-4.5'),
      providerModel('anthropic', 'claude-sonnet-4-20250514'),
      providerModel('openrouter', 'openai/gpt-5-mini'),
      providerModel('openai', 'gpt-4o'),
      ...localAgentic,
    ]),
    fallback: firstConfiguredChatModel([
      policyChatModel(policy.fallbackModel, available),
      providerModel('openrouter', 'meta-llama/llama-3.3-70b-instruct:free'),
      ...localAgentic,
    ]),
    localAgentic,
  };
}

function policyChatModel(model: string | undefined, availableLocalModels: Set<string>): string | undefined {
  const name = sanitizeModelName(model);
  if (!name) return undefined;
  const slash = name.indexOf('/');
  if (slash > 0) {
    const backend = name.slice(0, slash).toLowerCase();
    const preset = OPENAI_COMPATIBLE_PRESETS[backend];
    return preset && readApiKey(preset) ? name : undefined;
  }
  return availableLocalModels.has(name.toLowerCase()) ? name : undefined;
}

function providerModel(backend: string, model: string): string | undefined {
  const preset = OPENAI_COMPATIBLE_PRESETS[backend];
  return preset && readApiKey(preset) ? `${backend}/${model}` : undefined;
}

function firstConfiguredChatModel(candidates: Array<string | undefined>): string | undefined {
  return candidates.map((name) => sanitizeModelName(name)).find((name) => name.length > 0);
}

function preferredLocalAgenticModels(requestedModel: string, availableModels: string[], policy: ModelRoutingPolicy = {}): string[] {
  const available = new Set(availableModels.map((name) => name.toLowerCase()));
  const candidates = [policy.strongModel, policy.defaultModel, policy.fallbackModel, ...PREFERRED_AGENTIC_FALLBACK_MODELS]
    .map((name) => sanitizeModelName(name))
    .filter((name) => name && name.toLowerCase() !== requestedModel.toLowerCase());
  return candidates.filter((name) => available.has(name.toLowerCase()));
}

/**
 * Classify a model's text/image/audio/tool-use capabilities from its name plus
 * any details surfaced by the backend (`OllamaModel.details`, `ListModel.details`).
 *
 * The classification drives UI hints, the agentic auto-routing fallback list,
 * and the `weak`/`strong` toolUse warning in the model picker. It is a best-
 * effort heuristic, not an authoritative capability registry.
 *
 * Tool-use tiers and their evidence sources:
 *
 * 1. Backend prefix ("provider/model") wins when the provider's preset declares
 *    `supportsTools`. Drives Groq/Mistral/OpenAI = strong, Cerebras/Cloudflare/
 *    DeepInfra = weak. See OPENAI_COMPATIBLE_PRESETS and REPLICATE_PRESET.
 * 2. `weakGemma4LocalToolModel` — pinned to gemma4:e4b/26b based on live probes
 *    that show full Harness tool turns are unreliable even though tiny one-tool
 *    loops succeed. See user-memory llm-backends.md.
 * 3. `weakToolModels` — small base models that historically misfire on tool
 *    calls (phi-3-mini, tinyllama, smollm, qwen2.5-3b and below).
 * 4. `strongToolModels` — families with confirmed reliable tool calling. The
 *    regex covers kimi, qwen-coder 14B/32B/72B/480B, gpt-oss :cloud variants,
 *    deepseek-v3/coder, the GLM 4/5 family (including :cloud variants), the
 *    mistral-medium/large families, command-r, gpt-4*, claude*, llama 70b.
 * 5. Falls back to `unknown` when nothing matches; the UI surfaces no warning
 *    for unknown so we err on the side of letting the user try.
 *
 * To extend: add the model family to `strongToolModels` or `weakToolModels`,
 * then add a test in src/web/server.test.ts under "classifies known :cloud
 * Ollama models" or its sibling tests.
 */
export function inferModelCapabilities(name: string, details: Record<string, unknown> = {}): { text: boolean; image: boolean; audio: boolean; toolUse: 'strong' | 'weak' | 'unknown'; notes: string[] } {
  const haystack = `${name} ${Object.values(details).join(' ')}`.toLowerCase();
  const image = isVisionCapableModelName(name, details);
  const audio = /whisper|audio|speech|wav2vec|parakeet|sensevoice/.test(haystack);

  // Tool-use capability heuristic based on model family and runtime path.
  const weakGemma4LocalToolModel = /^gemma4:(e4b|26b)$/i.test(name.trim());
  const weakToolModels = /phi-?3.*mini|tinyllama|smollm|qwen2?\.?5?-?(0\.5|1\.5|3)b/i;
  // Strong tool-use families. Includes :cloud variants of gpt-oss, qwen3-coder,
  // deepseek-v3, and the GLM 4/5 family which were previously classified as
  // unknown despite live probes confirming reliable tool calls.
  const strongToolModels = /kimi|qwen.*coder.*(14|32|72|480)b|qwen3-coder.*cloud|gpt-oss.*cloud|deepseek.*(v3|coder)|glm-?[45](\.\d+)?(:cloud)?|mistral.*(medium|large)|command-r|gpt-?4|claude|llama.*70b/i;

  // Cloud backend models: use the preset's supportsTools flag when available.
  const slash = name.indexOf('/');
  let cloudToolSupport: boolean | null = null;
  if (slash > 0) {
    const backend = name.slice(0, slash).toLowerCase();
    const preset = OPENAI_COMPATIBLE_PRESETS[backend];
    if (preset) cloudToolSupport = preset.supportsTools ?? null;
    else if (backend === 'replicate') cloudToolSupport = REPLICATE_PRESET.supportsTools ?? null;
  }

  const toolUse: 'strong' | 'weak' | 'unknown' =
    cloudToolSupport === false ? 'weak'
    : cloudToolSupport === true ? 'strong'
    : weakGemma4LocalToolModel ? 'weak'
    : weakToolModels.test(name) ? 'weak'
    : strongToolModels.test(name) ? 'strong'
    : 'unknown';

  const notes = [
    image ? 'Can likely reason over images when the chat path passes image data.' : 'Text chat model unless another modality is documented by the model.',
    audio ? 'Audio-related model detected; transcription or audio tooling may be needed before chat.' : '',
    weakGemma4LocalToolModel ? 'Live probes show this local Gemma 4 model is unreliable for Harness tool-calling turns; auto-route tool/current-information tasks to a stronger available model.' : '',
    toolUse === 'weak' ? 'This model may not reliably call tools (web_search, file_read, etc.). For research or file tasks, consider a larger model.' : '',
    cloudToolSupport === false ? 'This cloud backend does not support tool calling.' : '',
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
    webReadMaxChars,
    timeBudgetMs,
    context: {
      configuredMaxTokens: contextMaxTokens,
      detectedMaxTokens: detectedContextMaxTokens,
      effectiveMaxTokens: resolveEffectiveContextMaxTokensFromKnown(contextMaxTokens, detectedContextMaxTokens),
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
    teammate: teammateSettings,
    modelDebugLog,
    disabledTools: Array.from(disabledTools).sort(),
    timedToolEnables: Object.fromEntries(Array.from(timedToolEnables.entries()).filter(([, exp]) => Date.now() < exp).map(([name, exp]) => [name, new Date(exp).toISOString()])),
    autonomyExpiresAt: autonomyExpiresAt > Date.now() ? new Date(autonomyExpiresAt).toISOString() : '',
    autonomyPreviousMode,
    killSwitch: { active: killSwitchActive, reason: killSwitchReason },
    sandbox: sandboxSwitch.snapshot(),
    capabilityGrants,
    allowedExternalPaths: getAllowedExternalPaths(),
    agentOutputDir,
    telegramBotToken,
    telegramAllowedChatIds,
    discordBotToken: '',
    discordAllowedChannelIds,
    slackWebhookUrl: '',
    whatsappAccessToken: '',
    whatsappPhoneNumberId: whatsappPhoneNumberId || process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappAllowedRecipients: whatsappAllowedRecipients || process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS || '',
    ccmemUrl,
    browserRedaction,
  };
}

async function getPublicSettings(): Promise<PublicWebSettings> {
  await buildContextHealth().catch(() => undefined);
  const settings = getCurrentSettings();
  return {
    ...settings,
    discordBotToken: '',
    slackWebhookUrl: '',
    whatsappAccessToken: '',
    connectorSecretStatus: {
      discordBotToken: getConnectorSecretStatus('HARNESS_DISCORD_BOT_TOKEN'),
      slackWebhookUrl: getConnectorSecretStatus('HARNESS_SLACK_WEBHOOK_URL'),
      whatsappAccessToken: getConnectorSecretStatus('HARNESS_WHATSAPP_ACCESS_TOKEN'),
    },
  };
}

function getConnectorSecretStatus(envName: string): ConnectorSecretStatus {
  const envValue = process.env[envName];
  if (typeof envValue === 'string' && envValue.trim().length > 0) return { configured: true, source: FILE_SOURCED_KEYS.has(envName) ? 'file' : 'env' };
  return { configured: false, source: 'none' };
}

function connectorSecretValue(envName: string): string {
  return typeof process.env[envName] === 'string' ? process.env[envName]!.trim() : '';
}

function formatMyceliumContextText(contextText: string, maxChars: number): string {
  if (contextText.length <= maxChars) return contextText;
  const lines = contextText.split('\n').filter((line) => line.trim());
  const selected: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (chars + line.length + 1 > maxChars) break;
    selected.push(line);
    chars += line.length + 1;
  }
  return selected.join('\n') + `\n...(mycelium route context trimmed from ${lines.length} to ${selected.length} item(s) for prompt budget)`;
}

async function resolveContextMaxTokens(model: string): Promise<number> {
  // Per-model profile wins over the global cap when set, so switching
  // models in the UI never drags a wrong global setting along (cycle 18).
  const profile = await getModelProfile(PROJECT_DIR, model).catch(() => undefined);
  const profileCap = typeof profile?.contextMaxTokens === 'number' ? profile.contextMaxTokens : undefined;
  const globalCap = Number.isFinite(contextMaxTokens) ? contextMaxTokens : DEFAULT_CONTEXT_MAX_TOKENS;
  const configured = profileCap ?? globalCap;
  const detected = await webRuntime.getModelContextWindow(model, ollamaHost);
  detectedContextMaxTokens = detected;

  // Auto-detect by default. The configured value is now treated as a
  // user-set CAP (max), not a target:
  //
  //   * configured ≤ 0 OR a known legacy default (8192, 4096)  → use detected
  //                                                             (or 8192 fallback when undetectable)
  //   * configured > 0 AND deliberate                          → cap detected at configured
  //
  // Net effect: users on a cloud model with a 128k window get 128k
  // automatically without having to touch settings, while explicit
  // throttles ("never exceed 1024 tokens for cost reasons") are honoured.
  return resolveEffectiveContextMaxTokensFromKnown(configured, detected);
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
    await migrateLegacyConnectorSecrets(settings);
  } catch {
    // Missing or malformed settings should not prevent the local UI from starting.
  }
  // Restore persisted workflow runs so /api/workflows/runs survives a server
  // restart. Best-effort: failures are logged inside restoreRuns and never
  // block startup.
  try {
    await workflowRegistry.restoreRuns();
  } catch (error) {
    logger.warn('Startup', 'Failed to restore workflow runs', { error: error instanceof Error ? error.message : String(error) });
  }
}

export function resetSettingsLoadedForTest(): void {
  settingsLoaded = false;
}

async function migrateLegacyConnectorSecrets(settings: Partial<WebSettings>): Promise<void> {
  let migrated = false;
  const discordToken = String(settings.discordBotToken ?? '').trim().slice(0, 200);
  if (discordToken) {
    await storeConnectorSecret('HARNESS_DISCORD_BOT_TOKEN', discordToken);
    migrated = true;
  }
  const slackWebhook = sanitizeSlackWebhookUrl(settings.slackWebhookUrl);
  if (slackWebhook) {
    await storeConnectorSecret('HARNESS_SLACK_WEBHOOK_URL', slackWebhook);
    migrated = true;
  }
  const whatsappToken = String(settings.whatsappAccessToken ?? '').trim().slice(0, 500);
  if (whatsappToken) {
    await storeConnectorSecret('HARNESS_WHATSAPP_ACCESS_TOKEN', whatsappToken);
    migrated = true;
  }
  discordBotToken = '';
  slackWebhookUrl = '';
  whatsappAccessToken = '';
  if (migrated) await saveSettingsToDisk();
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
      // Always load from file — the file is the source of truth for
      // credentials saved through the UI. This ensures updated keys are
      // picked up on restart even when a stale env var exists from a
      // prior run. Shell-environment keys (set before the process
      // started) will be re-overwritten here only if the user also
      // stored a value in the file, which is intentional.
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
  'HARNESS_DISCORD_BOT_TOKEN',
  'HARNESS_SLACK_WEBHOOK_URL',
  'HARNESS_WHATSAPP_ACCESS_TOKEN',
  'HARNESS_WHATSAPP_PHONE_NUMBER_ID',
  'HARNESS_WHATSAPP_ALLOWED_RECIPIENTS',
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
  if (settings.teammate !== undefined) {
    teammateSettings = sanitizeTeammateSettings(settings.teammate);
  }
  if (settings.modelDebugLog !== undefined) {
    modelDebugLog = sanitizeModelDebugLogSettings(settings.modelDebugLog);
    applyModelDebugLogEnvironment(modelDebugLog);
  }
  configureAutomationScheduler();
  if (Array.isArray(settings.disabledTools)) {
    const registry = createToolRegistry(PROJECT_DIR);
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
    restoreKillSwitchState(ks);
  }
  if (settings.sandbox !== undefined && typeof settings.sandbox === 'object' && settings.sandbox !== null) {
    const sb = settings.sandbox as { active?: unknown; reason?: unknown };
    sandboxSwitch.restore({
      active: Boolean(sb?.active),
      reason: typeof sb?.reason === 'string' ? sb.reason : '',
    });
  }
  if (settings.capabilityGrants !== undefined) capabilityGrants = sanitizeCapabilityGrants(settings.capabilityGrants);
  if (settings.browserRedaction !== undefined) browserRedaction = sanitizeBrowserRedaction(settings.browserRedaction);
  if (settings.contextMaxTokens !== undefined) contextMaxTokens = clampNumber(settings.contextMaxTokens, 0, 200_000, DEFAULT_CONTEXT_MAX_TOKENS);
  if (settings.webReadMaxChars !== undefined) {
    webReadMaxChars = sanitizeWebReadMaxChars(settings.webReadMaxChars, DEFAULT_WEB_READ_MAX_CHARS);
    configureWebReadTool({ maxChars: webReadMaxChars });
  }
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
  if (settings.discordBotToken !== undefined) {
    discordBotToken = '';
  }
  if (settings.discordAllowedChannelIds !== undefined) {
    discordAllowedChannelIds = String(settings.discordAllowedChannelIds).trim().slice(0, 500);
  }
  if (settings.slackWebhookUrl !== undefined) {
    slackWebhookUrl = '';
  }
  if (settings.whatsappAccessToken !== undefined || settings.whatsappPhoneNumberId !== undefined || settings.whatsappAllowedRecipients !== undefined) {
    const sanitized = sanitizeWhatsAppSetup({
      accessToken: '',
      phoneNumberId: settings.whatsappPhoneNumberId ?? whatsappPhoneNumberId,
      allowedRecipients: settings.whatsappAllowedRecipients ?? whatsappAllowedRecipients,
    });
    whatsappAccessToken = '';
    whatsappPhoneNumberId = sanitized.phoneNumberId;
    whatsappAllowedRecipients = sanitized.allowedRecipients;
    if (whatsappPhoneNumberId) process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID = whatsappPhoneNumberId;
    if (whatsappAllowedRecipients) process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS = whatsappAllowedRecipients;
  }
  if (settings.ccmemUrl !== undefined) {
    ccmemUrl = String(settings.ccmemUrl).trim().slice(0, 500);
    setCcmemUrl(ccmemUrl || 'http://localhost:8765');
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
  if (source.autoEscalateOnLowReadiness !== undefined) policy.autoEscalateOnLowReadiness = source.autoEscalateOnLowReadiness === true;
  if (source.chatRoutingMode !== undefined) policy.chatRoutingMode = sanitizeChatRoutingMode(source.chatRoutingMode);
  return policy;
}

function sanitizeChatRoutingMode(value: unknown): ChatRoutingMode {
  const mode = String(value ?? '').trim();
  return mode === 'off' || mode === 'costSaver' || mode === 'balanced' || mode === 'quality'
    ? mode
    : 'balanced';
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

function effectiveOutputValidationForMessage(message: string, modeHint?: HarnessMode): EffectiveOutputValidationSettings {
  if (!outputValidation.enabled || !outputValidation.autoSelect) {
    return { ...outputValidation, selectionSource: 'manual-selected', selectionReason: 'Manual profile override is active.' };
  }
  // Use a neutral fallback so vague or short prompts do not inherit a sticky stored profile (e.g. coding-answer).
  // The mode hint (when supplied by the caller) lets the suggester override the
  // keyword table when the upstream mode classifier already knows the user is
  // researching/maintaining rather than writing code.
  const suggestion = describeOutputValidationProfileSuggestion(message, 'oracle-prime', { modeHint });
  if (!suggestion.matched && outputValidation.skipOnLowSignal) {
    return { ...outputValidation, enabled: false, profile: suggestion.profile, selectionSource: 'auto-selected', selectionReason: 'No strong signal in the prompt; validation skipped (skip-on-low-signal is on).' };
  }
  return { ...outputValidation, profile: suggestion.profile, selectionSource: 'auto-selected', selectionReason: suggestionReason(suggestion.profile, suggestion.matched, modeHint) };
}

function suggestionReason(profile: OutputValidationProfile, matched = true, modeHint?: HarnessMode): string {
  if (!matched) return `No strong signal in the prompt; defaulted to ${profile}.`;
  if ((modeHint === 'research' || modeHint === 'maintain') && profile === 'oracle-prime') {
    return `Mode classifier flagged this prompt as ${modeHint}; using the analytical profile so prose answers are not graded as code changes.`;
  }
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

function sanitizeAutomationSchedulerSettings(value: unknown): AutomationSchedulerSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : true,
    idleThresholdMinutes: clampInt(source.idleThresholdMinutes, 1, 60, 2),
  };
}

function sanitizeModelDebugLogSettings(value: unknown): ModelDebugLogSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const rawPath = typeof source.path === 'string' ? source.path.trim().slice(0, 500) : '';
  return {
    enabled: source.enabled === true,
    path: rawPath || '.harness/model-debug.jsonl',
  };
}

function applyModelDebugLogEnvironment(settings: ModelDebugLogSettings): void {
  if (settings.enabled) process.env.HARNESS_DEBUG_LOG = settings.path;
  else delete process.env.HARNESS_DEBUG_LOG;
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
  await withFileLock(OUTPUT_VALIDATION_PROFILES_PATH, () =>
    atomicWriteFile(OUTPUT_VALIDATION_PROFILES_PATH, JSON.stringify({ profiles: customOutputValidationProfiles }, null, 2)),
  );
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

/**
 * Resolve the subset of session attachments that are readable PDFs to their
 * absolute paths in the uploads dir. Mirrors the name-sanitisation and
 * existence checks in buildAttachmentsContextBlock so /research can read the
 * exact files the user attached.
 */
async function resolveAttachmentPdfPaths(raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const uploadsDir = getUploadsDir();
  const out: string[] = [];
  for (const entry of raw.slice(0, 20)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : null;
    if (!name) continue;
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeName || path.extname(safeName).toLowerCase() !== '.pdf') continue;
    const absolute = path.join(uploadsDir, safeName);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile()) out.push(absolute);
    } catch {
      // Missing on disk — skip.
    }
  }
  return out;
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
    // Append a head preview for text-like extensions so the model can
    // answer "what's in attachment X?" without spending a tool call on
    // file_read. Cap at ATTACHMENT_PREVIEW_MAX_CHARS so even a list of
    // 20 attachments stays inside the prompt budget.
    const preview = await readAttachmentPreview(absolute, safeName);
    if (preview) {
      const indented = preview.split('\n').map((p) => `    ${p}`).join('\n');
      lines.push(`  preview (first ${preview.length} chars):`);
      lines.push(indented);
    }
  }
  if (lines.length === 0) return null;
  return [
    '--- Session Attachments (authoritative) ---',
    'The user attached the following files via the Harness UI. These paths are exact and verified by the harness.',
    'Always pass the exact "path" string to file_read, pdf_read, document_read, image_analyze, or audio_transcribe — never strip the .harness/uploads/ prefix and never pass only the bare filename.',
    'You may also call list_uploads at any time to re-list every available attachment.',
    'A short head preview is included inline for text-like attachments so you can often answer without reading the whole file.',
    ...lines,
  ].join('\n');
}

// Extensions whose first few hundred bytes are useful inline. Binary
// formats (image/audio/video) and PDF are deliberately excluded because
// their head bytes are not human-readable. PDF still needs `pdf_read`.
const ATTACHMENT_PREVIEW_EXTENSIONS = new Set<string>([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.rb', '.php', '.cs', '.sh', '.bat',
  '.ps1', '.sql', '.html', '.htm', '.css', '.scss', '.xml', '.toml', '.ini',
  '.env', '.diff', '.patch', '.jsonl',
]);
// Extensions where the *tail* is usually as informative as the head
// (logs grow at the end; CSV/JSONL summaries often sit at the bottom).
// When a file in this set exceeds ATTACHMENT_PREVIEW_MAX_CHARS we
// emit a head+tail preview instead of plain head.
const ATTACHMENT_TAIL_PREVIEW_EXTENSIONS = new Set<string>([
  '.log', '.csv', '.tsv', '.jsonl',
]);
const ATTACHMENT_PREVIEW_MAX_CHARS = 400;
const ATTACHMENT_TAIL_PREVIEW_MAX_CHARS = 200;

async function readAttachmentPreview(absolute: string, filename: string): Promise<string | null> {
  const ext = path.extname(filename).toLowerCase();
  if (!ATTACHMENT_PREVIEW_EXTENSIONS.has(ext)) return null;
  const useHeadTail = ATTACHMENT_TAIL_PREVIEW_EXTENSIONS.has(ext);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolute);
  } catch {
    return null;
  }
  // Head read: up to ~4KB so we can trim cleanly on a line boundary;
  // cheap because uploads are local files.
  let head: string;
  let tail = '';
  try {
    const handle = await fs.open(absolute, 'r');
    try {
      const headBuf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(headBuf, 0, headBuf.length, 0);
      head = headBuf.subarray(0, bytesRead).toString('utf-8');
      // Tail read only when the file is genuinely large enough that the
      // head won't already cover it.
      if (useHeadTail && stat.size > 4096 + ATTACHMENT_TAIL_PREVIEW_MAX_CHARS) {
        const tailBufSize = Math.min(2048, stat.size);
        const tailBuf = Buffer.alloc(tailBufSize);
        const { bytesRead: tailBytes } = await handle.read(tailBuf, 0, tailBufSize, Math.max(0, stat.size - tailBufSize));
        tail = tailBuf.subarray(0, tailBytes).toString('utf-8');
      }
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  if (!head.trim()) return null;
  // Trim head to budget on a line boundary when possible so the preview
  // never ends mid-word.
  let headPreview = head.slice(0, ATTACHMENT_PREVIEW_MAX_CHARS);
  if (headPreview.length === ATTACHMENT_PREVIEW_MAX_CHARS) {
    const lastNewline = headPreview.lastIndexOf('\n');
    if (lastNewline > ATTACHMENT_PREVIEW_MAX_CHARS / 2) headPreview = headPreview.slice(0, lastNewline);
    headPreview = headPreview.trimEnd() + '\n…(truncated)';
  }
  if (!tail) return headPreview;
  // Tail trim: keep the last ATTACHMENT_TAIL_PREVIEW_MAX_CHARS, snapped
  // to a leading newline so we don't start mid-line.
  let tailPreview = tail.slice(-ATTACHMENT_TAIL_PREVIEW_MAX_CHARS);
  const firstNewline = tailPreview.indexOf('\n');
  if (firstNewline > 0 && firstNewline < ATTACHMENT_TAIL_PREVIEW_MAX_CHARS / 2) {
    tailPreview = tailPreview.slice(firstNewline + 1);
  }
  tailPreview = tailPreview.trimEnd();
  return headPreview + '\n…(file tail)\n' + tailPreview;
}

async function persistSessionLearning(session: SessionStorage, projectDir: string): Promise<void> {
  const events = await session.readAll();
  const candidate = extractLearningCandidate(session.getSessionId(), events);
  await appendLearningCandidate(projectDir, candidate);
}

let _saveSettingsLock: Promise<void> = Promise.resolve();
let settingsPersistenceStatus: {
  status: 'never_saved' | 'ok' | 'error';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
} = { status: 'never_saved', lastAttemptAt: null, lastSuccessAt: null, lastErrorAt: null, lastError: null };
async function saveSettingsToDisk(): Promise<void> {
  // Serialize saves to prevent concurrent write races
  _saveSettingsLock = _saveSettingsLock.then(_doSaveSettings, _doSaveSettings);
  return _saveSettingsLock;
}
async function _doSaveSettings(): Promise<void> {
  const attemptAt = new Date().toISOString();
  settingsPersistenceStatus = { ...settingsPersistenceStatus, lastAttemptAt: attemptAt };
  try {
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
    await renameSettingsFileWithRetry(tmpPath, SETTINGS_PATH);
    settingsPersistenceStatus = { status: 'ok', lastAttemptAt: attemptAt, lastSuccessAt: new Date().toISOString(), lastErrorAt: null, lastError: null };
  } catch (error) {
    settingsPersistenceStatus = {
      ...settingsPersistenceStatus,
      status: 'error',
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

async function renameSettingsFileWithRetry(tmpPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; attempt <= SETTINGS_SAVE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (error) {
      if (!isTransientSettingsRenameError(error) || attempt === SETTINGS_SAVE_RETRY_DELAYS_MS.length) throw error;
      const code = (error as NodeJS.ErrnoException).code || 'unknown';
      logger.warn('Settings', 'Retrying settings save after transient rename failure', { code, attempt: attempt + 1 });
      await delay(SETTINGS_SAVE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isTransientSettingsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkSourceDistFreshness(): Promise<void> {
  const { sourceKey, distKey } = resolveHarnessSourceDistFreshnessPaths();
  try {
    const [srcStat, distStat] = await Promise.all([fs.stat(sourceKey), fs.stat(distKey)]);
    if (srcStat.mtimeMs > distStat.mtimeMs + 1000) {
      console.log(`\n  ⚠️  Source files are newer than compiled output.`);
      console.log(`      Run "npm run build" to pick up recent changes.`);
    }
  } catch { /* dist or source missing — skip check */ }
}

export async function startServer(): Promise<ReturnType<typeof app.listen>> {
  const startupProfile = createStartupProfile();
  startupProfile.record('module-route-init', MODULE_LOAD_STARTED_AT);
  // Project-dir self-check. The v0.4.10 install_skill bug was one instance
  // of an entire failure class: a module-level state holder (skillsDir,
  // agentsDir, etc.) silently falls back to process.cwd() when its
  // setXxxDir() wiring is forgotten. We catch the visible half of that
  // class at boot by logging the resolved absolute path for each
  // .harness/ subdir so misconfiguration is loud, not silent.
  logger.info('Startup', 'Project directory layout', {
    PROJECT_DIR,
    skills: SKILLS_DIR,
    chatHistory: HISTORY_DIR,
    traces: TRACES_DIR,
    documents: DOCUMENTS_DIR,
    workflows: WORKFLOWS_DIR,
    settingsPath: SETTINGS_PATH,
    apiKeysPath: API_KEYS_PATH,
  });
  if (!process.env.HARNESS_PROJECT_DIR) {
    logger.info('Startup', 'HARNESS_PROJECT_DIR not set — using process.cwd()', { cwd: process.cwd() });
  }
  await ensureSettingsLoaded();
  startupProfile.record('settings-load');
  // Surface any active/paused goal that survived the restart so operators
  // see it in the boot log even before they open the UI. Best-effort; a
  // failure here must not block startup.
  try { await surfaceResumableGoalOnBoot(PROJECT_DIR); } catch { /* ignore */ }
  const staleSessionCount = await SessionStorage.markStaleRunningSessions(PROJECT_DIR, MODULE_LOAD_STARTED_AT).catch(() => 0);
  if (staleSessionCount > 0) logger.warn('Sessions', `Marked ${staleSessionCount} stale running session(s) as aborted after restart`);
  startupProfile.record('stale-session-cleanup');
  await checkSourceDistFreshness();
  startupProfile.record('source-freshness');
  // Sweep stale whisper-tmp WAVs from prior crashes/timeouts. The transcribe
  // route unlinks on success but leaks on hard failure; a 30-day-old 50MB
  // WAV pile slowly fills the harness data dir if we never sweep.
  try {
    const tmpDir = path.join(PROJECT_DIR, '.harness', 'jarvis', 'whisper-tmp');
    const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith('stt-') || !name.endsWith('.wav')) continue;
      const full = path.join(tmpDir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(full);
          removed += 1;
        }
      } catch { /* file may have been removed by another sweep */ }
    }
    if (removed > 0) logger.info('Startup', `Swept ${removed} stale whisper-tmp WAV(s) older than 24h`);
  } catch { /* best-effort, never block startup */ }
  startupProfile.record('whisper-tmp-sweep');
  // Auto-detect whisper model + python so out-of-the-box installs get
  // hands-free voice without any env-var setup. Skipped silently when the
  // user has already set HARNESS_WHISPER_BINARY or HARNESS_WHISPER_PYTHON.
  await detectWhisperFallback();
  startupProfile.record('whisper-auto-detect');
  const preferred = parseInt(process.env.PORT ?? '3000', 10);
  const port = await findAvailablePort(preferred);
  startupProfile.record('port-selection');

  // Wire model-backed /research analysis. When unavailable, /research falls
  // back to its token-free stub, so this is best-effort.
  registerResearchHooks({
    callModel: async (prompt: string): Promise<string> => {
      const model = currentModel || summarizerModel;
      if (!model) throw new Error('No model configured for /research analysis');
      const client = webRuntime.createClient(model, ollamaHost);
      const response = await client.chat([{ role: 'user', content: prompt }]);
      return response.message?.content ?? '';
    },
  });

  // Wire YOLO mode hooks so /yolo in chat can set dontAsk + start autonomy.
  registerYoloHooks({
    currentMode: permissionMode,
    setPermissionMode: (mode: string, reason: string) => {
      const prev = permissionMode;
      permissionMode = mode as PermissionMode;
      appendCapabilityAuditEvent(PROJECT_DIR, { type: 'grant.created', reason: `permission.mode → ${mode}: ${reason} (was ${prev})` }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
    },
    engageTimedAutonomy: (minutes: number, reason: string) => {
      if (minutes > 0) {
        autonomyPreviousMode = permissionMode !== 'dontAsk' ? permissionMode : autonomyPreviousMode || 'default';
        permissionMode = 'dontAsk' as PermissionMode;
        autonomyExpiresAt = Date.now() + minutes * 60_000;
        appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.engaged', reason: `${reason} (${minutes}m, reverts to ${autonomyPreviousMode})` }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
      } else {
        if (autonomyPreviousMode) permissionMode = autonomyPreviousMode as PermissionMode;
        autonomyExpiresAt = 0;
        appendCapabilityAuditEvent(PROJECT_DIR, { type: 'autonomy.timed.cleared', reason }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
      }
    },
    startAutonomyRun: async (settings) => {
      try {
        const url = `http://${LOCAL_HOST}:${port}/api/autonomy/start`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            maxIterations: settings.maxIterations,
            maxTurns: settings.maxTurns,
            timeBudgetMs: settings.timeBudgetMs,
            unproductiveTurnLimit: settings.unproductiveTurnLimit,
            permissionMode: 'dontAsk',
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await r.json() as Record<string, unknown>;
        if (!r.ok) return { started: false, error: data.error as string ?? `HTTP ${r.status}` };
        return { started: true, pid: data.pid as number | undefined };
      } catch (err) {
        return { started: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const httpServer = app.listen(port, LOCAL_HOST, () => {
    startupProfile.record('listen-ready');
    logger.info('Startup', 'Web startup phases', startupProfile.summary());
    const url = `http://${LOCAL_HOST}:${port}`;
    if (port !== preferred) {
      console.log(`\n  ⚠️  Port ${preferred} was in use — using ${port} instead.`);
    }
    console.log(`\n  🤖 Ollama Agent Harness`);
    console.log(`  ───────────────────────`);
    console.log(`  Open in your browser:  ${url}`);
    console.log(`  Ollama host:           ${ollamaHost}`);
    console.log(`  WebSocket:             ws://${LOCAL_HOST}:${port}/ws`);
    console.log(`  API auth:              ${API_AUTH_REQUIRED ? (API_AUTH_TOKEN ? 'required' : 'required (token missing)') : 'disabled'}`);
    if (assistantProfileEnabled()) {
      console.log(`  Profile:               assistant (voice + ambient + channels on by default)`);
    }
    if (proactiveProfileEnabled()) {
      console.log(`  Proactive autonomy:    on (heartbeat + triggers default on; set HARNESS_HEARTBEAT_ENABLED=0 / HARNESS_TRIGGERS_ENABLED=0 to force off)`);
    }
    if (API_AUTH_INSECURE_OVERRIDE) {
      console.log('  Security warning:      HARNESS_API_AUTH_REQUIRED=0 while HARNESS_API_AUTH_TOKEN is set');
      logger.warn('Security', 'API auth explicitly disabled despite configured token', {
        envOverride: 'HARNESS_API_AUTH_REQUIRED=0',
        tokenConfigured: true,
      });
    }

    if (startupConnectorsEnabled()) {
      // Start Telegram bot if token is configured.
      const tgToken = telegramBotToken || process.env.HARNESS_TELEGRAM_BOT_TOKEN;
      if (tgToken) {
        loadPersistedChatIds(PROJECT_DIR).then(() => {
          const bot = startTelegramBot(tgToken, url, telegramAllowedChatIds ? telegramAllowedChatIds.split(',') : undefined);
          if (bot) console.log(`  Telegram bot:          connected`);
        }).catch((err) => recordSwallowed('server.ts:9626', err));
      }

      // Start Discord bot if token is configured.
      const dcToken = discordBotToken || process.env.HARNESS_DISCORD_BOT_TOKEN;
      if (dcToken) {
        const bot = startDiscordBot(dcToken, url, discordAllowedChannelIds ? discordAllowedChannelIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
        if (bot) console.log(`  Discord bot:           connecting...`);
      }
    }

    console.log(`\n  Press Ctrl+C to stop.\n`);

    // Attach WebSocket server for live multi-client event streaming.
    try {
      attachWsServer(httpServer, {
        coalesceWindowMs: Number(process.env.HARNESS_WS_COALESCE_MS ?? '0') || 0,
      });
    } catch (error) {
      logger.warn('Startup', 'Failed to attach WebSocket server', { error: error instanceof Error ? error.message : String(error) });
    }

    // Start the self-learning heartbeat (no-op unless HARNESS_HEARTBEAT_ENABLED).
    try {
      configureSelfLearningHeartbeat();
      if (selfLearningHeartbeat) console.log(`  Heartbeat:             enabled`);
    } catch (error) {
      logger.warn('Startup', 'Failed to start self-learning heartbeat', { error: error instanceof Error ? error.message : String(error) });
    }

    // Start the trigger scheduler (no-op unless HARNESS_TRIGGERS_ENABLED).
    try {
      configureTriggerScheduler();
      if (triggerScheduler) console.log(`  Triggers:              enabled`);
    } catch (error) {
      logger.warn('Startup', 'Failed to start trigger scheduler', { error: error instanceof Error ? error.message : String(error) });
    }

    // Start the teammate scheduler. Always wires up the API, but only ticks
    // when teammate.enabled is true (controlled by the welcome card / wizard).
    try {
      configureTeammateScheduler();
      if (teammateSettings.enabled) console.log(`  Teammate brief:        on at ${teammateSettings.scheduleTime}`);
    } catch (error) {
      logger.warn('Startup', 'Failed to start teammate scheduler', { error: error instanceof Error ? error.message : String(error) });
    }

    // Start the identity auto-update scheduler. Always-on once started;
    // .harness/identity/auto-update.json governs whether the tick does anything.
    try {
      configureIdentityAutoUpdateScheduler();
      console.log(`  Identity heartbeat:    on`);
    } catch (error) {
      logger.warn('Startup', 'Failed to start identity auto-update scheduler', { error: error instanceof Error ? error.message : String(error) });
    }

    // Attach OTLP exporter (no-op unless HARNESS_OTEL_EXPORT_ENABLED + endpoint set).
    try {
      configureOtlpExporter();
      if (otlpExporterHandle) console.log(`  OTLP exporter:         enabled`);
    } catch (error) {
      logger.warn('Startup', 'Failed to attach OTLP exporter', { error: error instanceof Error ? error.message : String(error) });
    }

    // Start Jarvis ambient daemon (no-op unless HARNESS_AMBIENT_ENABLED=1).
    // Watches IMPLEMENTATION_PLAN.md + git working tree and emits NervousSignals
    // onto an isolated bus exposed via /api/jarvis/status and /api/jarvis/brief.
    try {
      if (ambientEnabled()) {
        jarvisAmbientHandle = startAmbientDaemon(jarvisAmbientBus, {
          watchDir: PROJECT_DIR,
          fileFilters: ['IMPLEMENTATION_PLAN.md', 'src/', 'cookbook/', '.harness/'],
          gitPollMs: Number(process.env.HARNESS_AMBIENT_GIT_POLL_MS ?? '15000') || 15000,
          schedulerMs: Number(process.env.HARNESS_AMBIENT_SCHEDULER_MS ?? '0') || 0,
          projectDir: PROJECT_DIR,
        });
        console.log(`  Jarvis ambient:        enabled (${jarvisAmbientHandle.watchersActive().join(', ') || 'no watchers'})`);
      }
    } catch (error) {
      logger.warn('Startup', 'Failed to start Jarvis ambient daemon', { error: error instanceof Error ? error.message : String(error) });
    }

    // Mirror evidence cards into the Jarvis knowledge graph (best-effort).
    // Hook is fire-and-forget; an exception in ingest never blocks the append.
    try {
      setEvidenceAppendHook(async (projectDir: string, evidence: StoredRunEvidence) => {
        await ingestEvidenceCard(projectDir, evidence);
      });
    } catch (error) {
      logger.warn('Startup', 'Failed to register Jarvis evidence ingester', { error: error instanceof Error ? error.message : String(error) });
    }

    // Load the persisted runtime registry so voice/inbound adapter state
    // survives restart.
    try {
      void loadRuntimeRegistry(PROJECT_DIR).catch((error: unknown) => {
        logger.warn('Startup', 'Failed to load Jarvis runtime registry', { error: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      logger.warn('Startup', 'Failed to load Jarvis runtime registry', { error: error instanceof Error ? error.message : String(error) });
    }

    // Ambient → action subscriber. Batches recent signals every minute and
    // applies the default policy: KG ingest for file changes, save the daily
    // brief on git transitions back to clean. No shell side effects.
    // Gate on the same env flag as the daemon itself: if ambient isn't
    // enabled the daemon never starts, so the subscriber would only ever
    // early-return — registering the timer at all is dead work and made
    // it possible for ambient brief files to appear in test runs that
    // never opted into ambient mode.
    try {
      if (process.env.HARNESS_AMBIENT_ENABLED === '1') {
        const ambientActionTimer = setInterval(async () => {
          if (!jarvisAmbientHandle?.isRunning()) return;
          const recent = jarvisAmbientBus.recent();
          const actions = defaultAmbientActionPolicy.evaluate(recent);
          for (const action of actions) {
            try {
              if (action.kind === 'kg_ingest_file') {
                const files = (action.payload?.files as string[] | undefined) ?? [];
                for (const file of files) {
                  await upsertEntity(PROJECT_DIR, 'file', file, { source: 'ambient' }, 'ambient');
                }
              } else if (action.kind === 'save_brief') {
                const snap = await snapshotDailyBrief({ projectDir: PROJECT_DIR, ambientSignals: recent, windowDescription: 'ambient trigger' });
                const dir = path.join(PROJECT_DIR, '.harness', 'documents');
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(path.join(dir, `jarvis-brief-ambient-${Date.now()}.md`), snap.markdown, 'utf-8');
              }
            } catch { /* per-action best-effort */ }
          }
        }, 60_000);
        if (typeof ambientActionTimer.unref === 'function') ambientActionTimer.unref();
        schedulerRegistry.register({
          name: 'jarvis-ambient-action',
          stop: () => clearInterval(ambientActionTimer),
          isRunning: () => true,
        });
      }
    } catch (error) {
      logger.warn('Startup', 'Failed to start Jarvis ambient action subscriber', { error: error instanceof Error ? error.message : String(error) });
    }

    // Load webhooks: persisted registry first, then any env-configured webhook.
    initWebhookStore(PROJECT_DIR);
    loadWebhooksFromEnv();

    // Load the governed-loop review queue from disk.
    initReviewQueue(PROJECT_DIR);
    // Point the replay consumer at the same project's drained-answer seam.
    initReplayConsumer(PROJECT_DIR);
    // Durable audit trail for idle replays that run while the user is away.
    initReplayLedger(PROJECT_DIR);

    // ccmem auth: env var wins; otherwise pick up the token persisted by
    // start.bat / start.sh so a harness launched on its own (e.g. `npm run
    // serve`) can still talk to an authenticated memory sidecar. Best-effort:
    // if there is no token file, ccmem simply runs unauthenticated.
    if (!process.env.HARNESS_CCMEM_TOKEN?.trim()) {
      try {
        const tokenFromFile = readFileSync(path.join(PROJECT_DIR, '.harness', 'ccmem', 'token'), 'utf-8').trim();
        if (tokenFromFile) setCcmemToken(tokenFromFile);
      } catch {
        // No persisted token — leave the client unauthenticated.
      }
    }

    // Auto-build code intelligence graph (non-blocking).
    loadRepoGraph(PROJECT_DIR).then((existing) => {
      if (!existing) {
        buildRepoGraph(PROJECT_DIR, { maxFiles: 5_000, ignoreDirs: ['apex-agent-main', 'agent-outputs', 'journal', 'Bracknell_Food_Business'] }).then((graph) => {
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
            } catch (err) { recordSwallowed('startup.myceliumCodeSeed', err); }
          });
        }).catch((err) => recordSwallowed('server.ts:9768', err));
      }
    }).catch((err) => recordSwallowed('server.ts:9770', err));

    if (process.env.NO_OPEN !== '1') {
      openBrowser(url);
    }
  });
  return httpServer;
}

function createStartupProfile(): { record: (phase: string, since?: number) => void; summary: () => Record<string, number> } {
  const timings: Record<string, number> = {};
  let last = Date.now();
  return {
    record(phase: string, since = last): void {
      const now = Date.now();
      timings[phase] = now - since;
      last = now;
    },
    summary(): Record<string, number> {
      return { ...timings };
    },
  };
}

export { app };

export function startupConnectorsEnabled(): boolean {
  return process.env.HARNESS_DISABLE_STARTUP_CONNECTORS !== '1';
}

export function setWebRuntimeOverrides(overrides: Partial<WebRuntimeDeps>): () => void {
  webRuntime = { ...defaultWebRuntime, ...overrides };
  return () => { webRuntime = defaultWebRuntime; };
}

async function shutdownServer(server: ReturnType<typeof app.listen>, signal: NodeJS.Signals): Promise<void> {
  logger.info('Process', 'Graceful shutdown requested', { signal });
  const closeHttp = new Promise<void>((resolve) => {
    server.close((error?: Error) => {
      if (error) recordSwallowed('server.shutdown.http.close', error);
      resolve();
    });
  });
  const stopSubsystems = (async () => {
    try { await stopAllSchedulers(); } catch (error) { recordSwallowed('server.shutdown.schedulers', error); }
    try { stopTelegramBot(); } catch (error) { recordSwallowed('server.shutdown.telegram', error); }
    try { stopDiscordBot(); } catch (error) { recordSwallowed('server.shutdown.discord', error); }
    try { jarvisAmbientHandle?.stop(); jarvisAmbientHandle = null; } catch (error) { recordSwallowed('server.shutdown.ambient', error); }
  })();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([Promise.allSettled([closeHttp, stopSubsystems]).then(() => undefined), timeout]);
}

if (require.main === module) {
  // Process-level safety net. Installed only when this file is the entry
  // point so importing server.ts from tests does not register handlers
  // that would catch the test runner's own failures.
  //
  // Policy:
  //  - unhandledRejection: log + record in the silent-failure sink, do
  //    NOT exit. Node's default future is to exit; we keep the harness
  //    alive because losing a long-running session to a single bad
  //    promise is worse than a quietly logged error.
  //  - uncaughtException: log + record + exit(1). The process state is
  //    not trustworthy after an uncaught throw; let the OS / launcher
  //    restart cleanly rather than serve from a half-broken state.
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error('Process', 'Unhandled promise rejection (kept process alive)', { message });
    recordSwallowed('process.unhandledRejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Process', 'Uncaught exception (exiting)', { message: error.message, stack: error.stack });
    recordSwallowed('process.uncaughtException', error);
    // Give the logger a tick to flush stderr before we go.
    setTimeout(() => process.exit(1), 50);
  });
  startServer().then((server) => {
    let shuttingDown = false;
    const handleSignal = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      shutdownServer(server, signal).finally(() => process.exit(0));
    };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
