// Adapter interface — the bridge between the Harness and any agent runtime.
//
// Adapters are the core abstraction that makes the orchestration layer
// runtime-agnostic. Each adapter knows how to:
//   1. Execute a prompt on its target runtime (Ollama, OpenAI, Claude CLI, etc.)
//   2. Report diagnostics (is the runtime available, what models are configured)
//   3. Parse output into a structured RunResult
//
// Built-in adapters: ollama-local, openai-http, process, claude-cli
// Custom adapters can be registered at runtime.

import type { Tool, ToolResult } from '../types';

// ─── Core Types ────────────────────────────────────────────────────

export type AdapterType = 'ollama-local' | 'openai-http' | 'process' | 'claude-cli' | 'http-webhook' | 'custom';

export interface AdapterConfig {
  /** Unique identifier for this adapter instance. */
  id: string;
  /** Which adapter type to use. */
  type: AdapterType;
  /** Human-readable name. */
  name: string;
  /** Configuration specific to the adapter type. */
  settings: Record<string, unknown>;
  /** Whether this adapter is active. */
  enabled: boolean;
}

export interface RunContext {
  /** The project directory for file operations. */
  projectDir: string;
  /** Company ID scoping this run. */
  companyId: string;
  /** Agent ID executing the run. */
  agentId: string;
  /** The prompt to execute. */
  prompt: string;
  /** Environment variables to inject into the agent process. */
  env?: Record<string, string>;
  /** Tools available to the agent. */
  tools?: Tool[];
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** Budget for this run. */
  budget?: RunBudget;
  /** Optional session state from a previous run (for heartbeat continuity). */
  previousSessionState?: Record<string, unknown>;
}

export interface RunBudget {
  /** Maximum number of turns the agent may take. */
  maxTurns?: number;
  /** Maximum wall-clock time in milliseconds. */
  maxTimeMs?: number;
  /** Maximum estimated cost in USD. */
  maxCostUsd?: number;
}

export interface RunResult {
  /** Whether the run completed successfully. */
  success: boolean;
  /** The primary text output. */
  output: string;
  /** Error message if the run failed. */
  error?: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Number of turns taken. */
  turnsUsed: number;
  /** Estimated token counts. */
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  /** Estimated cost in USD. */
  costUsd?: number;
  /** Tool calls made during the run. */
  toolCalls?: RunToolCall[];
  /** Session state to persist for the next heartbeat. */
  sessionState?: Record<string, unknown>;
  /** Structured result data. */
  data?: Record<string, unknown>;
}

export interface RunToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  timestamp: string;
}

export interface AdapterDiagnostics {
  available: boolean;
  reason?: string;
  models?: string[];
  version?: string;
  latencyMs?: number;
}

// ─── Adapter Interface ──────────────────────────────────────────────

export interface Adapter {
  /** The adapter type identifier. */
  readonly type: AdapterType;

  /** Human-readable label. */
  readonly label: string;

  /** Execute a prompt and return the result. */
  execute(context: RunContext): Promise<RunResult>;

  /** Check whether the adapter runtime is available. */
  diagnostics(): Promise<AdapterDiagnostics>;

  /** Parse raw stdout into a structured run result (for CLI adapters). */
  parseOutput?(rawStdout: string): Partial<RunResult>;
}

// ─── Adapter Registry ───────────────────────────────────────────────

const adapterRegistry = new Map<string, Adapter>();
const adapterConfigs = new Map<string, AdapterConfig>();

/**
 * Register an adapter instance. Overwrites any existing adapter with the same id.
 */
export function registerAdapter(config: AdapterConfig, adapter: Adapter): void {
  adapterConfigs.set(config.id, config);
  adapterRegistry.set(config.id, adapter);
}

/**
 * Get a registered adapter by id.
 */
export function getAdapter(id: string): Adapter | undefined {
  return adapterRegistry.get(id);
}

/**
 * Get an adapter's config by id.
 */
export function getAdapterConfig(id: string): AdapterConfig | undefined {
  return adapterConfigs.get(id);
}

/**
 * List all registered adapter configs.
 */
export function listAdapterConfigs(): AdapterConfig[] {
  return Array.from(adapterConfigs.values());
}

/**
 * List all registered adapter instances.
 */
export function listAdapters(): Array<{ config: AdapterConfig; adapter: Adapter }> {
  const out: Array<{ config: AdapterConfig; adapter: Adapter }> = [];
  for (const [id, config] of adapterConfigs) {
    const adapter = adapterRegistry.get(id);
    if (adapter) out.push({ config, adapter });
  }
  return out;
}

/**
 * List available adapters (those whose diagnostics report available).
 */
export async function listAvailableAdapters(): Promise<Array<{ config: AdapterConfig; diagnostics: AdapterDiagnostics }>> {
  const results: Array<{ config: AdapterConfig; diagnostics: AdapterDiagnostics }> = [];
  for (const [id, config] of adapterConfigs) {
    const adapter = adapterRegistry.get(id);
    if (!adapter) continue;
    const diagnostics = await adapter.diagnostics().catch(() => ({ available: false, reason: 'diagnostics failed' }));
    results.push({ config, diagnostics });
  }
  return results;
}

/**
 * Unregister an adapter by id.
 */
export function unregisterAdapter(id: string): boolean {
  const had = adapterRegistry.delete(id) && adapterConfigs.delete(id);
  return had;
}

/**
 * Clear all registered adapters. Test use only.
 */
export function clearAdapterRegistry(): void {
  adapterRegistry.clear();
  adapterConfigs.clear();
}