// Public surface for the Jarvis layer.

export {
  RUNG_NAMES,
  canActAutonomously,
  ensureCapability,
  explainRung,
  getRung,
  loadTrustLadder,
  recordOutcome,
  requiresConfirmation,
  saveTrustLadder,
} from './trustLadder';
export type { CapabilityTrust, TrustLadderSnapshot, TrustRung } from './trustLadder';

export {
  appendRecord,
  findEntityByName,
  getKnowledgeGraphStatus,
  readAll,
  recall,
  upsertEntity,
} from './knowledgeGraph';
export type {
  GraphEdge,
  GraphEntity,
  GraphFact,
  GraphRecord,
  GraphRecordKind,
  KnowledgeGraphStatus,
  RecallResult,
} from './knowledgeGraph';

export { collectAmbientSignals, startAmbientDaemon } from './ambientDaemon';
export type { AmbientDaemonHandle, AmbientWatcherOptions } from './ambientDaemon';

export { mineNextActions, suggestNextAfter } from './predictiveEngine';
export type { ActionEvent, MineOptions, NextActionSuggestion } from './predictiveEngine';

export { runCouncil } from './modelCouncil';
export type {
  CouncilAnswer,
  CouncilMember,
  CouncilMode,
  CouncilOptions,
  CouncilResult,
  Invoke,
} from './modelCouncil';

export { composeDailyBrief } from './dailyBrief';
export type { BriefInputs } from './dailyBrief';

export {
  getSpeechToText,
  getTextToSpeech,
  getVoiceStatus,
  getWakeWord,
  setSpeechToText,
  setTextToSpeech,
  setWakeWord,
} from './voice';
export type { SpeechToText, TextToSpeech, VoiceStatus, WakeWord } from './voice';

export {
  getInboundTriageStatus,
  registerInboundPoller,
  triageBatch,
  triageInboundMessage,
} from './inboundTriage';
export type {
  InboundChannel,
  InboundMessage,
  InboundTriageStatus,
  TriageBatch,
  TriageBucket,
  TriageOptions,
  TriageResult,
  TriageRule,
} from './inboundTriage';

export { HarnessMcpServer, StubTransport, getMcpServerStatus } from './mcpServer';
export type {
  McpRequest,
  McpResponse,
  McpServerOptions,
  McpServerStatus,
  McpToolDescriptor,
} from './mcpServer';

export { singleRequest, startMcpStdioServer } from './mcpStdio';
export type { StdioServerHandle, StdioServerOptions } from './mcpStdio';

export { eventsFromAmbientSignals, eventsFromEvidenceCards, eventsFromSession, mergeAndSort } from './predictiveAdapter';

export { ingestEvidenceCard } from './evidenceIngester';
export type { IngestResult } from './evidenceIngester';

export { evaluatePermissionGate, shouldDeferToEngine } from './permissionGate';
export type { GateDecision, GateInput, GateResult } from './permissionGate';

export { recordPermissionOutcome } from './permissionFeedback';
export type { PermissionOutcomeKind, RecordPermissionOutcomeOptions } from './permissionFeedback';

export { snapshotDailyBrief } from './briefScheduler';
export type { BriefSnapshot, BriefSnapshotOptions } from './briefScheduler';

export { applyGrantToLadder } from './grantBridge';
export type { BridgeResult, GrantAction } from './grantBridge';

export { compactKnowledgeGraph, compactRecords } from './knowledgeGraphCompaction';
export type { CompactionResult, CompactionStats } from './knowledgeGraphCompaction';

export { clearRuntimeRegistry, getRuntimeRegistryStatus, isFeatureReady, markRuntimeInstalled } from './runtimeRegistry';
export type { RuntimeFeature, RuntimeRegistryStatus } from './runtimeRegistry';

export { defaultBriefTriggerDefinition } from './briefTrigger';
export type { BriefTriggerOptions } from './briefTrigger';

export { composeMermaidGraph } from './knowledgeGraphViz';
export type { MermaidGraphOptions } from './knowledgeGraphViz';

export { diffBriefs } from './briefDiff';
export type { BriefDiffResult, SectionDiff } from './briefDiff';

export { mergeLadders } from './ladderImport';
export type { LadderMergeStrategy, MergeStats } from './ladderImport';

export { defaultAmbientActionPolicy } from './ambientActions';
export type { AmbientAction, AmbientActionKind, AmbientActionPolicy } from './ambientActions';

export { runCouncilForChat } from './councilAdapter';
export type { CouncilClientFactory, CouncilForChatOptions } from './councilAdapter';

export { loadRuntimeRegistry, saveRuntimeRegistry } from './runtimeRegistry';
