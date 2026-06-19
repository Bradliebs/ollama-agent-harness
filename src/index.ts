// Ollama Agent Harness — main entry point
export { queryLoop } from './core/queryLoop';
export type { QueryLoopDeps } from './core/queryLoop';
export { OllamaClient } from './core/ollamaClient';
export { RuntimeTracer, runtimeTracer } from './core/tracing';
export { describeOutputValidationProfileSuggestion, getOutputValidationInstructions, normalizeCustomOutputValidationProfiles, OUTPUT_VALIDATION_PROFILES, OUTPUT_VALIDATION_PROFILE_TEMPLATES, parseOutputValidationProfile, suggestOutputValidationProfile, validateOutput, withOutputValidationInstructions } from './core/outputValidation';
export type { BuiltInOutputValidationProfile, CustomOutputValidationCheck, CustomOutputValidationProfile, OutputValidationFinding, OutputValidationProfile, OutputValidationProfileInfo, OutputValidationProfileTemplate, OutputValidationResult, OutputValidationStatus } from './core/outputValidation';
export { HarnessError, OllamaConnectionError, ContextOverflowError, ToolExecutionError, PermissionDeniedError, withRetry, errorToToolResult } from './core/errors';
export { classifyError, isRetryable, computeRetryDelayMs } from './core/retryClass';
export type { RetryClass, ClassifiedError } from './core/retryClass';
export { ToolDispatcher, getBuiltinTools, FileReadTool, FileWriteTool, FileEditTool, ListFilesTool, MakeDirectoryTool, BashTool, WebFetchTool, ImageAnalyzeTool, AudioTranscribeTool, PdfReadTool, PdfMetadataTool, PdfRenderPageTool, PdfExtractTablesTool, ToolRegistry, createBuiltinToolRegistry } from './tools';
export { PermissionEngine } from './permissions/engine';
export { assembleSystemContext, assembleToolSchemas, assembleUserContext, buildInitialMessages, estimateTokenCount } from './context/assembly';
export { applyBudgetReduction, applySnip, applyAutoCompact, compactIfNeeded, validateCompactionSummary, DEFAULT_COMPACTION_CONFIG, COMPACTION_STRATEGIES, isCompactionBoundary, AUTO_COMPACT_BOUNDARY_PREFIX } from './context/compaction';
export type { CompactionStrategy } from './context/compaction';
export { SessionStorage } from './persistence/sessionStorage';
export { resumeSession, forkSession, getLatestSession } from './persistence/resume';
export { createContinuityCheckpoint } from './persistence/continuity';
export { classifyConfidenceMode, DEFAULT_REVIEW_THRESHOLD } from './governed/confidenceMode';
export type { ConfidenceMode, ConfidenceModeSignals, ConfidenceModeResult } from './governed/confidenceMode';
export { buildWorkingMemory } from './governed/workingMemory';
export type { WorkingMemory, WorkingMemoryExtras } from './governed/workingMemory';
export { selfCritique, DEFAULT_STALE_SOURCE_MS } from './governed/selfCritique';
export type { SelfCritiqueInput, SelfCritiqueResult, SelfCritiqueFinding, SelfCritiqueStatus } from './governed/selfCritique';
export { governAnswer } from './governed/governedAnswer';
export type { GovernedAnswer, GovernedAnswerInput, BrainUpdateProposal } from './governed/governedAnswer';
export {
  initReviewQueue,
  enqueueReviewItem,
  listReviewItems,
  resolveReviewItem,
  enqueueFromGoverned,
  getGovernanceMetrics,
} from './governed/reviewQueue';
export type { ReviewItem, ReviewItemKind, ReviewItemStatus, EnqueueReviewInput, GovernanceMetrics } from './governed/reviewQueue';
export { initReplayConsumer, readReplayCandidates, consumeReplayCandidates } from './governed/replayConsumer';
export type { ReplayCandidate } from './governed/replayConsumer';
export { runReplayCandidates } from './governed/replayRunner';
export type { ReplayRunResult, RunReplayOptions } from './governed/replayRunner';
export { initReplayLedger, appendReplayLedgerEntry, readReplayLedger } from './governed/replayLedger';
export type { ReplayLedgerEntry } from './governed/replayLedger';
export { rebuildSemanticMemory, searchSemanticMemory } from './persistence/semanticMemory';
export { getSessionSearchIndexStatus, rebuildSessionSearchIndex, rebuildSessionSearchIndexWithMetadata, searchSessions } from './persistence/sessionSearchIndex';
export type { SessionSearchEntry, SessionSearchIndexFile, SessionSearchIndexMetadata, SessionSearchIndexStatus, SessionSearchResult } from './persistence/sessionSearchIndex';
export { createAutomationJob, deleteAutomationJob, executeDueJobs, listAutomationJobs, listDueAutomationJobs, markAutomationJobRun, parseAutomationSchedule, readAutomationRunLog, updateAutomationJob } from './automation/jobs';
export type { AutomationJob, AutomationRunUpdate, AutomationSchedule, AutomationScheduleKind } from './automation/jobs';
export { buildAutomationPrompt, prepareAutomationRun } from './automation/runner';
export { AutomationScheduler } from './automation/scheduler';
export { MyceliumGraph, loadMyceliumGraph, saveMyceliumGraph } from './mycelium/graph';
export { MycelialContextRouter, createMycelialRouter, computeSemanticRelevance } from './mycelium/router';
export { spreadActivation, selectRoute } from './mycelium/activation';
export { reinforceRoute, weakenRoute, decayUnusedEdges, computeReward } from './mycelium/reinforcement';
export { classifyTask, getExplorationRate, getNodeLimit, isHighRiskTaskType } from './mycelium/taskClassifier';
export type { MyceliumTaskType, MyceliumTaskClassification } from './mycelium/taskClassifier';
export { seedGenericGraph, seedCodeIntelligence, SAFETY_NODES, GENERIC_AGENT_NODES, GENERIC_PROMPT_NODES, GENERIC_WORKFLOW_NODES, GENERIC_VERIFIER_NODES, USER_PREFERENCE_NODES, MODEL_PROVIDER_NODES, SERVICE_NODES, COMMAND_HANDLER_NODES, CAPABILITY_NODES, BACKGROUND_WORKER_NODES, NOTIFICATION_TEMPLATE_NODES, GENERIC_EDGES } from './mycelium/seeds';
export type { CodeIntelSeedInput } from './mycelium/seeds';
export { buildContextPackage, buildRouteExplanation, formatRouteExplanation } from './mycelium/contextPackage';
export type { ContextPackage, ContextPackageItem, RouteExplanation } from './mycelium/contextPackage';
export { heuristicVerifier } from './mycelium/verifier';
export type { VerifierInput, VerifierResult } from './mycelium/verifier';
export { runPanel } from './verification/panel';
export type { Signal, SignalAxis, SignalContext, SignalResult, PanelConfig, PanelResult, PerSignalReport, PerAxisReport } from './verification/panel';
export { BUILTIN_SIGNALS, outputValidationSignal, testResultsSignal, lintErrorsSignal, schemaCheckSignal, toolSuccessSignal, safetyHardCheckSignal } from './verification/builtinSignals';
export { planSurgicalRepair, planSurgicalRepairForChecks } from './verification/critic';
export type { SurgicalRepairOptions, SurgicalRepairPlan, RepairableCheck } from './verification/critic';
export { BUILTIN_MODEL_CATALOG, getModelCatalog, getModelCatalogCacheStatus, listCatalogModels, readModelCatalogCache, validateModelCatalogManifest, writeModelCatalogCache } from './models/modelCatalog';
export type { GetModelCatalogOptions, ModelCatalogCacheStatus, ModelCatalogManifest, ModelCatalogModel, ModelCatalogProvider } from './models/modelCatalog';
export { ModelRegistry, BUILTIN_MODEL_REGISTRY } from './models/modelRegistry';
export type { ModelRegistryEntry, ModelRegistryManifest, ModelRole, CostLevel, PrivacyLevel, SpeedLevel } from './models/modelRegistry';
export { ModelRouter } from './models/modelRouter';
export type { RouterTaskType, ModelRoutingResult } from './models/modelRouter';
export { classifyMode, getModeDescription, MODE_DESCRIPTIONS } from './services/modeClassifier';
export type { HarnessMode, ModeClassification } from './services/modeClassifier';
export { CapabilityRegistry, createDefaultCapabilityRegistry, SERVICE_FEATURE_REQUIREMENTS, getFeatureRequirements } from './services/capabilityRegistry';
export type { CapabilityId, CapabilityStatus, Capability, CapabilityCheckResult, CapabilityChecker } from './services/capabilityRegistry';
export { BUILTIN_CAPABILITY_TEMPLATE_STARTERS, BUILTIN_CONNECTOR_CONTRACTS, BUILTIN_MESSAGE_INGRESS_POLICY, CONNECTOR_CONTRACT_FIXTURES, getCapabilityTemplateStarter, getMessageIngressPolicy, listCapabilityTemplateStarters, listConnectorContractFixtures, listConnectorReadinessContracts, validateConnectorReadinessContracts } from './services/capabilityTemplateStarters';
export type { AutomationTemplateStarter, CapabilityTemplateStarter, CapabilityTemplateStarterArtifact, CapabilityTemplateStarterKind, CapabilityTemplateTriggerContract, CapabilityTemplateTriggerMode, CapabilityTemplateTriggerStatus, ConnectorContractFixture, ConnectorContractValidationFinding, ConnectorOperationContract, ConnectorOperationMode, ConnectorReadinessContract, DocumentTemplateStarter, MessageIngressChannelPolicy, MessageIngressPolicy } from './services/capabilityTemplateStarters';
export { WorkerQueue } from './services/workerQueue';
export type { WorkerJob, WorkerJobResult, WorkerJobType, WorkerJobStatus, WorkerExecutor, WorkerQueueSnapshot } from './services/workerQueue';
export { extractCommands, parseJsonCommands, validateStateTransition, createTransitionEvent } from './services/commandExtractor';
export type { ServiceCommandType, ExtractedCommand, CommandExtractionResult, StateTransitionEvent } from './services/commandExtractor';
export { DEFAULT_EXECUTORS, registerDefaultExecutors } from './services/workerExecutors';
export { discoverExtensionManifests } from './extensibility/extensionManifest';
export type { ExtensionManifest, ExtensionManifestKind } from './extensibility/extensionManifest';
export { AgentTool, appendSubagentRoutingMetric, createSubagentTool, createSubAgentToolsFromDefinition, DEFAULT_SUBAGENT_MAX_DEPTH, listSubagentRoutingMetrics, renderSubAgentPrompt, runSubagent, resolveSubagentConfig } from './agents/subagent';
export type { SubAgentToolFactoryDeps, SubagentRoutingMetric } from './agents/subagent';
export { HELPER_AGENT_PRESETS, calibrateModelRoutingPolicy, createHelperAgentConfig, getHelperAgentPreset, selectModelForTask, summarizeRoutingMetrics } from './agents/modelRouting';
export type { HelperAgentPreset, HelperTaskType, ModelRoutingCalibration, ModelRoutingDecision, ModelRoutingInput, ModelRoutingPolicy, ModelTier, RoutingMetricBucket, RoutingMetricInput, RoutingMetricsSummary, TaskRisk } from './agents/modelRouting';
export { appendLearningCandidate, extractLearningCandidate, getLearningCandidateProvenance, listLearningCandidateReviews, listLearningCandidates, listReviewedLearningCandidates, promoteLearningCandidate, reviewLearningCandidate } from './learning/sessionLearning';
export type { LearningCandidateOptions, LearningCandidateProvenance, LearningCandidateProvenanceEvent, LearningCandidateReview, LearningCandidateReviewAction, PromotedLearningCandidate, ReviewedLearningCandidate, SessionLearningCandidate } from './learning/sessionLearning';
export { appendEvalTraceExample, createEvalTraceExample, createOutputValidationTrendExport, createReplayEvalExample, deleteEvalTraceExample, listEvalTraceExamples, listEvalTraceRuns, readEvalTraceDataset, runEvalTraceDataset, summarizeEvalTraceRuns, summarizeOutputValidationRuns, updateEvalTraceExampleTags } from './learning/evalTrace';
export type { EvalTraceExample, EvalTraceOptions, EvalTraceRun, EvalTraceRunResult, EvalTraceRunTrend, OutputValidationEvalRunOptions, OutputValidationRunTrend, OutputValidationSelectionSource, OutputValidationTrendExport, ReplayEvalActuals, ReplayEvalOptions, ReplayEvalRunOptions, ReplayEvalSourceLinks, TraceSnapshot } from './learning/evalTrace';
export { loadSkillsDir, parseSkillFile, matchSkillTrigger } from './extensibility/skillLoader';
export { HookPipeline } from './extensibility/hookPipeline';
export { renderTemplate, renderTemplateDetailed } from './prompts/template';
export type { RenderResult, TemplateContext, TemplateValue } from './prompts/template';
export type { LoopConfig, LoopEvent, OutputValidationEvent, Tool, ToolResult, ToolCall, PermissionRule, PermissionMode, SessionEvent, SessionMeta, ContinuityCheckpoint, Hook, HookContext, HookResult } from './types';

// ─── Promise Ledger ─────────────────────────────────────────────────
export { createPromise, listPromises, updatePromise, checkObligations, fulfilPromise, failPromise, detectCommitments } from './services/promiseLedger';
export type { AgentPromise, PromiseStatus, PromiseBreachEvent, ObligationCheckResult } from './services/promiseLedger';// ─── Service Lifecycle ──────────────────────────────────────────────
export { canTransition, getServiceLifecycle, getServiceTemplate, initServiceLifecycle, probeServiceHealth, transitionService, SERVICE_TEMPLATES } from './services/serviceLifecycle';
export type { ServiceLifecycleStatus, ServiceLifecycleState, ServiceTransitionResult, ServiceTemplate } from './services/serviceLifecycle';

// ─── Event Store ────────────────────────────────────────────────────
export { appendEvent, emitEvent, queryEvents, getEvent, createSnapshot, getSnapshot, listSnapshots, getUndoEvents, summarizeEventStore, generatePostmortem, pruneEventStore, pruneEventsByAge, subscribeEventStream } from './persistence/eventStore';
export type { EventCategory, HarnessEvent, EventSnapshot, EventQuery, EventStoreSummary } from './persistence/eventStore';

// ─── Done-State Verifier ────────────────────────────────────────────
export { verifyCode, verifyService, verifyPromiseFulfillability } from './core/doneStateVerifier';
export type { VerificationDomain, VerificationStatus, VerificationCheck, VerificationResult, PromiseVerifyInput } from './core/doneStateVerifier';

// ─── Task Store ─────────────────────────────────────────────────────
export { createTask, deleteTask, detectStaleTasks, getTask, listTasks, recordCheckIn, summarizeTasks, updateTask } from './services/taskStore';
export type { Task, TaskCheckIn, TaskPriority, TaskStatus, CreateTaskInput, UpdateTaskInput, StaleTaskReport } from './services/taskStore';

// ─── Memory Intelligence ────────────────────────────────────────────
export { appendMemorySection, parseMemoryFile, renderMemoryFileForPrompt, runMemoryGc, runMemoryMaintenance, searchMemory, serializeMemoryFile } from './services/memoryIntelligence';
export type { Importance, MemoryFile, MemorySection, MemoryGcSummary, MemoryMaintenanceSummary, RankedSection } from './services/memoryIntelligence';

// ─── Self-Learning Heartbeat ────────────────────────────────────────
export { SelfLearningHeartbeat, createIdentityGcAction, createWorkAssignedTasksAction, defaultHeartbeatActions, readHeartbeatHistory, writeHeartbeatHistory } from './services/selfLearningHeartbeat';
export type { HeartbeatAction, HeartbeatActionResult, HeartbeatRunRecord, IdentityGcActionOptions, SelfLearningHeartbeatOptions, TaskAgentRunner, WorkAssignedTasksOptions } from './services/selfLearningHeartbeat';

// ─── Custom Agents ──────────────────────────────────────────────────
export { BUILTIN_AGENT_ROLES, loadAgentDefinitions, parseAgentFile, resolveAgentDefinition, scanAgentDefinitions, writeCustomAgent } from './agents/agentLoader';
export type { AgentDefinition, AgentLoadDiagnostic, AgentDirectoryScan, AgentRole as CustomAgentRole, CreateCustomAgentInput, SubAgentRef } from './agents/agentLoader';
export { AGENT_ID_PATTERN, assertValidAgentId, isValidAgentId, requireAgentDefinition, UnknownAgentError } from './agents/agentId';

// ─── Triggers ───────────────────────────────────────────────────────
export { TriggerScheduler, loadTriggers, normalizeEnvelope, saveTriggers } from './services/triggerScheduler';
export type { TriggerDefinition, TriggerEnvelope, TriggerExecutionResult, TriggerSchedulerOptions, TriggerSpawnFn } from './services/triggerScheduler';

// ─── Concierge Triage ───────────────────────────────────────────────
export { classifyIntent, logConciergeDecision, readConciergeLog } from './services/concierge';
export type { ConciergeLogEntry, TriageOptions, TriageResult } from './services/concierge';

// ─── Audit Hook ─────────────────────────────────────────────────────
export { appendAuditEntry, auditFilePath, createAuditHooks, readAuditLog, renderRecentAuditForPrompt } from './permissions/audit';
export type { AuditEntry, AuditHookOptions, RenderRecentAuditOptions } from './permissions/audit';

// ─── Shell Risk Classifier ──────────────────────────────────────────
export { classifyShellCommand, mergeRules, splitCommandSegments } from './permissions/shellRiskClassifier';
export type { RiskClassification, RiskTier } from './permissions/shellRiskClassifier';
export { DEFAULT_DANGEROUS_RULES, DEFAULT_SAFE_RULES, DEFAULT_SHELL_RULES } from './permissions/defaultShellRules';
export type { ShellRule } from './permissions/defaultShellRules';
export { createShellRiskHooks, resolveShellRules } from './permissions/shellRiskHook';
export type { ShellRiskHookOptions } from './permissions/shellRiskHook';

// ─── Job Ledger ─────────────────────────────────────────────────────
export { collectRunningEntries, completeJob, DEFAULT_STALE_AFTER_MS, heartbeatJob, jobLedgerPath, listOrphanedRuns, readLedger, recoverOrphanedJobs, startJob } from './automation/jobLedger';
export type { LedgerEvent, LedgerJobKind, LedgerJobStatus, OrphanedEntry, RecoverOrphanedJobsOptions, RunningEntry, StartedJob, StartJobInput } from './automation/jobLedger';

// ─── Session View Snapshot ──────────────────────────────────────────
export { createSessionViewEmitter, DEFAULT_RECENT_EVENT_LIMIT, DEFAULT_SESSION_VIEW_THROTTLE_MS, resolveSessionViewThrottleMs } from './web/snapshotEmitter';
export type { BroadcastFn, RecentEvent, SessionView, SessionViewEmitter, SessionViewEmitterOptions, SubscribeFn } from './web/snapshotEmitter';

// ─── Docker Sandbox ─────────────────────────────────────────────────
export { createDockerExecTool } from './tools/dockerExecTool';
export type { DockerExecOptions, DockerSpawnFn } from './tools/dockerExecTool';

// ─── Squad Channels ─────────────────────────────────────────────────
export { createSquad, deleteSquad, getSquad, listSquads, planHandoff, routeMessage, updateSquad } from './services/squad';
export type { CreateSquadInput, HandoffPlan, RouteResult, SquadAgentSlot, SquadAutonomy, SquadDefinition, SquadRoutingRule } from './services/squad';
export { clearSquadForSession, getSquadForSession, resolveSessionSquad, setSquadForSession } from './services/squadSessions';

// ─── Identity Layer ─────────────────────────────────────────────────
export { deleteStructuredEntry, exportIdentity, importIdentity, queryStructured, readIdentityFile, readIdentitySnapshot, readStructuredStore, renderIdentityForPrompt, runIdentityGc, upsertStructuredEntry, writeIdentityFile } from './services/identity';
export type { IdentityExport, IdentityFileName, IdentityGcOptions, IdentityGcSummary, IdentitySnapshot, ImportIdentityOptions, ImportIdentitySummary, StructuredEntry, StructuredStore, UpsertStructuredInput } from './services/identity';
export { captureIdentitySnapshot, listIdentityHistory, loadIdentityHistory, restoreIdentityFromHistory } from './services/identityHistory';
export type { IdentitySnapshotMeta, IdentitySnapshotRecord } from './services/identityHistory';
export { acceptSoulProposal, applyUserProposal, discardSoulProposal, parseProposalResponse, proposeSoulUpdate, proposeUserUpdate, readSoulProposal } from './services/identityProposals';
export type { IdentityProposal, SoulProposalRecord } from './services/identityProposals';
export { readIdentityAutoUpdateConfig, runIdentityAutoUpdateTick, writeIdentityAutoUpdateConfig } from './services/identityAutoUpdate';
export type { IdentityAutoUpdateConfig, IdentityAutoUpdateDeps, IdentityAutoUpdateResult } from './services/identityAutoUpdate';
export { gatherIdentityObservations } from './services/identityObservations';
export type { ObservationsOptions, ObservationsResult } from './services/identityObservations';
export { IdentityAutoUpdateScheduler } from './services/identityAutoUpdateScheduler';
export type { IdentityAutoUpdateSchedulerOptions } from './services/identityAutoUpdateScheduler';

// ─── Subagent Orchestrator ──────────────────────────────────────────
export { orchestrate, mergeResults, mergeVerified, attachVerification, verifyCodeBranch, getAgentRoleDefaults } from './agents/orchestrator';
export type { AgentRole, AgentBudget, WorkstreamTask, WorkstreamResult, OrchestrationResult, BranchVerifier } from './agents/orchestrator';

// ─── Code Intelligence ──────────────────────────────────────────────
export { buildRepoGraph, analyzeImpact, summarizeRepo, saveRepoGraph, loadRepoGraph } from './core/codeIntelligence';
export type { CodeNode, CodeEdge, RepoGraph, ImpactAnalysis, RepoSummary } from './core/codeIntelligence';

// ─── Small Model Autopilot: Deterministic Shortcuts ─────────────────
export { tryDeterministicShortcut, listShortcutTypes } from './core/deterministicShortcuts';
export type { ShortcutResult } from './core/deterministicShortcuts';

// ─── Small Model Autopilot: Structured Output Validator ─────────────
export { validateStructuredOutput, parseAndValidate, detectSchema, BUILTIN_SCHEMAS } from './core/structuredOutputValidator';
export type { OutputSchema, SchemaValidationResult } from './core/structuredOutputValidator';

// ─── Small Model Autopilot: Readiness Gate ──────────────────────────
export { calculateReadiness, isReadyToExecute, shouldEscalate } from './core/readinessGate';
export type { ReadinessInput, ReadinessResult, ReadinessDecision } from './core/readinessGate';
