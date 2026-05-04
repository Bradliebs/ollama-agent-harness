// Ollama Agent Harness — main entry point
export { queryLoop } from './core/queryLoop';
export type { QueryLoopDeps } from './core/queryLoop';
export { OllamaClient } from './core/ollamaClient';
export { RuntimeTracer, runtimeTracer } from './core/tracing';
export { describeOutputValidationProfileSuggestion, getOutputValidationInstructions, normalizeCustomOutputValidationProfiles, OUTPUT_VALIDATION_PROFILES, OUTPUT_VALIDATION_PROFILE_TEMPLATES, parseOutputValidationProfile, suggestOutputValidationProfile, validateOutput, withOutputValidationInstructions } from './core/outputValidation';
export type { BuiltInOutputValidationProfile, CustomOutputValidationCheck, CustomOutputValidationProfile, OutputValidationFinding, OutputValidationProfile, OutputValidationProfileInfo, OutputValidationProfileTemplate, OutputValidationResult, OutputValidationStatus } from './core/outputValidation';
export { HarnessError, OllamaConnectionError, ContextOverflowError, ToolExecutionError, PermissionDeniedError, withRetry, errorToToolResult } from './core/errors';
export { ToolDispatcher, getBuiltinTools, FileReadTool, FileWriteTool, FileEditTool, ListFilesTool, BashTool, WebFetchTool, ImageAnalyzeTool, AudioTranscribeTool, PdfReadTool, PdfMetadataTool, PdfRenderPageTool, PdfExtractTablesTool, ToolRegistry, createBuiltinToolRegistry } from './tools';
export { PermissionEngine } from './permissions/engine';
export { assembleSystemContext, assembleToolSchemas, assembleUserContext, buildInitialMessages, estimateTokenCount } from './context/assembly';
export { applyBudgetReduction, applySnip, applyAutoCompact, compactIfNeeded, validateCompactionSummary, DEFAULT_COMPACTION_CONFIG } from './context/compaction';
export { SessionStorage } from './persistence/sessionStorage';
export { resumeSession, forkSession, getLatestSession } from './persistence/resume';
export { createContinuityCheckpoint } from './persistence/continuity';
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
export { WorkerQueue } from './services/workerQueue';
export type { WorkerJob, WorkerJobResult, WorkerJobType, WorkerJobStatus, WorkerExecutor, WorkerQueueSnapshot } from './services/workerQueue';
export { extractCommands, parseJsonCommands, validateStateTransition, createTransitionEvent } from './services/commandExtractor';
export type { ServiceCommandType, ExtractedCommand, CommandExtractionResult, StateTransitionEvent } from './services/commandExtractor';
export { DEFAULT_EXECUTORS, registerDefaultExecutors } from './services/workerExecutors';
export { discoverExtensionManifests } from './extensibility/extensionManifest';
export type { ExtensionManifest, ExtensionManifestKind } from './extensibility/extensionManifest';
export { AgentTool, appendSubagentRoutingMetric, listSubagentRoutingMetrics, runSubagent, resolveSubagentConfig } from './agents/subagent';
export type { SubagentRoutingMetric } from './agents/subagent';
export { HELPER_AGENT_PRESETS, calibrateModelRoutingPolicy, createHelperAgentConfig, getHelperAgentPreset, selectModelForTask, summarizeRoutingMetrics } from './agents/modelRouting';
export type { HelperAgentPreset, HelperTaskType, ModelRoutingCalibration, ModelRoutingDecision, ModelRoutingInput, ModelRoutingPolicy, ModelTier, RoutingMetricBucket, RoutingMetricInput, RoutingMetricsSummary, TaskRisk } from './agents/modelRouting';
export { appendLearningCandidate, extractLearningCandidate, getLearningCandidateProvenance, listLearningCandidateReviews, listLearningCandidates, listReviewedLearningCandidates, promoteLearningCandidate, reviewLearningCandidate } from './learning/sessionLearning';
export type { LearningCandidateOptions, LearningCandidateProvenance, LearningCandidateProvenanceEvent, LearningCandidateReview, LearningCandidateReviewAction, PromotedLearningCandidate, ReviewedLearningCandidate, SessionLearningCandidate } from './learning/sessionLearning';
export { appendEvalTraceExample, createEvalTraceExample, createOutputValidationTrendExport, createReplayEvalExample, deleteEvalTraceExample, listEvalTraceExamples, listEvalTraceRuns, readEvalTraceDataset, runEvalTraceDataset, summarizeEvalTraceRuns, summarizeOutputValidationRuns, updateEvalTraceExampleTags } from './learning/evalTrace';
export type { EvalTraceExample, EvalTraceOptions, EvalTraceRun, EvalTraceRunResult, EvalTraceRunTrend, OutputValidationEvalRunOptions, OutputValidationRunTrend, OutputValidationSelectionSource, OutputValidationTrendExport, ReplayEvalActuals, ReplayEvalOptions, ReplayEvalRunOptions, ReplayEvalSourceLinks, TraceSnapshot } from './learning/evalTrace';
export { loadSkillsDir, parseSkillFile, matchSkillTrigger } from './extensibility/skillLoader';
export { HookPipeline } from './extensibility/hookPipeline';
export type { LoopConfig, LoopEvent, OutputValidationEvent, Tool, ToolResult, ToolCall, PermissionRule, PermissionMode, SessionEvent, SessionMeta, ContinuityCheckpoint, Hook, HookContext, HookResult } from './types';

// ─── Promise Ledger ─────────────────────────────────────────────────
export { createPromise, listPromises, updatePromise, checkObligations, fulfilPromise, failPromise, detectCommitments } from './services/promiseLedger';
export type { AgentPromise, PromiseStatus, PromiseBreachEvent, ObligationCheckResult } from './services/promiseLedger';

// ─── Service Lifecycle ──────────────────────────────────────────────
export { canTransition, getServiceLifecycle, getServiceTemplate, initServiceLifecycle, probeServiceHealth, transitionService, SERVICE_TEMPLATES } from './services/serviceLifecycle';
export type { ServiceLifecycleStatus, ServiceLifecycleState, ServiceTransitionResult, ServiceTemplate } from './services/serviceLifecycle';

// ─── Event Store ────────────────────────────────────────────────────
export { appendEvent, emitEvent, queryEvents, getEvent, createSnapshot, getSnapshot, listSnapshots, getUndoEvents, summarizeEventStore, generatePostmortem, pruneEventStore, pruneEventsByAge } from './persistence/eventStore';
export type { EventCategory, HarnessEvent, EventSnapshot, EventQuery, EventStoreSummary } from './persistence/eventStore';

// ─── Done-State Verifier ────────────────────────────────────────────
export { verifyCode, verifyService, verifyPromiseFulfillability } from './core/doneStateVerifier';
export type { VerificationDomain, VerificationStatus, VerificationCheck, VerificationResult, PromiseVerifyInput } from './core/doneStateVerifier';

// ─── Subagent Orchestrator ──────────────────────────────────────────
export { orchestrate, mergeResults, getAgentRoleDefaults } from './agents/orchestrator';
export type { AgentRole, AgentBudget, WorkstreamTask, WorkstreamResult, OrchestrationResult } from './agents/orchestrator';

// ─── Code Intelligence ──────────────────────────────────────────────
export { buildRepoGraph, analyzeImpact, summarizeRepo, saveRepoGraph, loadRepoGraph } from './core/codeIntelligence';
export type { CodeNode, CodeEdge, RepoGraph, ImpactAnalysis, RepoSummary } from './core/codeIntelligence';
