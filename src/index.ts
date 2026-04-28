// Ollama Agent Harness — main entry point
export { queryLoop } from './core/queryLoop';
export type { QueryLoopDeps } from './core/queryLoop';
export { OllamaClient } from './core/ollamaClient';
export { HarnessError, OllamaConnectionError, ContextOverflowError, ToolExecutionError, PermissionDeniedError, withRetry, errorToToolResult } from './core/errors';
export { ToolDispatcher, getBuiltinTools, FileReadTool, FileWriteTool, FileEditTool, ListFilesTool, BashTool, WebFetchTool } from './tools';
export { PermissionEngine } from './permissions/engine';
export { assembleSystemContext, assembleToolSchemas, assembleUserContext, buildInitialMessages, estimateTokenCount } from './context/assembly';
export { applyBudgetReduction, applySnip, applyAutoCompact, compactIfNeeded, DEFAULT_COMPACTION_CONFIG } from './context/compaction';
export { SessionStorage } from './persistence/sessionStorage';
export { resumeSession, forkSession, getLatestSession } from './persistence/resume';
export { AgentTool, runSubagent } from './agents/subagent';
export { loadSkillsDir, parseSkillFile, matchSkillTrigger } from './extensibility/skillLoader';
export { HookPipeline } from './extensibility/hookPipeline';
export type { LoopConfig, LoopEvent, Tool, ToolResult, ToolCall, PermissionRule, PermissionMode, SessionEvent, SessionMeta, Hook, HookContext, HookResult } from './types';
