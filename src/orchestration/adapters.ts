// Ollama Local Adapter — executes prompts against the local Ollama runtime.
//
// This is the built-in adapter for the Harness's native runtime. It wraps
// the existing queryLoop/subagent infrastructure and presents it through
// the Adapter interface so the orchestration layer can treat Ollama agents
// the same as any other runtime.

import * as path from 'path';
import { runSubagent, type SubagentConfig } from '../agents/subagent';
import { createHelperAgentConfig, type HelperTaskType } from '../agents/modelRouting';
import { resolveAgentDefinition } from '../agents/agentLoader';
import type { Tool } from '../types';
import type { IChatClient } from '../core/chatClient';
import {
  type Adapter,
  type AdapterConfig,
  type AdapterDiagnostics,
  type RunContext,
  type RunResult,
  type RunToolCall,
  registerAdapter,
} from './adapter';
import { logger } from '../core/logger';

// ─── Adapter Implementation ─────────────────────────────────────────

export class OllamaLocalAdapter implements Adapter {
  readonly type = 'ollama-local' as const;
  readonly label = 'Ollama Local';

  private getClient: () => IChatClient | null;
  private getTools: () => Tool[];
  private projectDir: string;

  constructor(deps: {
    getClient: () => IChatClient | null;
    getTools: () => Tool[];
    projectDir: string;
  }) {
    this.getClient = deps.getClient;
    this.getTools = deps.getTools;
    this.projectDir = deps.projectDir;
  }

  async execute(context: RunContext): Promise<RunResult> {
    const client = this.getClient();
    if (!client) {
      return {
        success: false,
        output: '',
        error: 'Ollama client not available',
        durationMs: 0,
        turnsUsed: 0,
      };
    }

    const tools = this.getTools();
    const startTime = Date.now();

    const config: SubagentConfig = {
      name: context.agentId,
      systemPrompt: `You are agent "${context.agentId}" working on company "${context.companyId}".`,
      model: context.env?.model,
      tools,
      maxTurns: context.budget?.maxTurns ?? 15,
      abortSignal: context.abortSignal,
    };

    try {
      const summary = await runSubagent(config, context.prompt, client, tools);
      const durationMs = Date.now() - startTime;

      return {
        success: true,
        output: summary,
        durationMs,
        turnsUsed: 1,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs,
        turnsUsed: 0,
      };
    }
  }

  async diagnostics(): Promise<AdapterDiagnostics> {
    const client = this.getClient();
    if (!client) {
      return { available: false, reason: 'Ollama client not initialized' };
    }

    try {
      const startMs = Date.now();
      // Check if Ollama is reachable by listing models
      const { Ollama } = await import('ollama');
      const ollama = new Ollama();
      const models = await ollama.list();
      const latencyMs = Date.now() - startMs;

      return {
        available: true,
        models: models.models?.map((m: { name: string }) => m.name) ?? [],
        latencyMs,
      };
    } catch (err) {
      return {
        available: false,
        reason: `Ollama not reachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ─── Process Adapter ─────────────────────────────────────────────────

export class ProcessAdapter implements Adapter {
  readonly type = 'process' as const;
  readonly label = 'Shell Process';

  private projectDir: string;

  constructor(deps: { projectDir: string }) {
    this.projectDir = deps.projectDir;
  }

  async execute(context: RunContext): Promise<RunResult> {
    const { spawn } = await import('child_process');
    const command = context.env?.command;
    if (!command) {
      return {
        success: false,
        output: '',
        error: 'No command specified in env.command',
        durationMs: 0,
        turnsUsed: 0,
      };
    }

    const startTime = Date.now();

    return new Promise<RunResult>((resolve) => {
      const env = { ...process.env, ...context.env };
      delete env.command; // Don't pass command as env var

      const child = spawn(command, [], {
        cwd: context.projectDir,
        env,
        shell: true,
        timeout: context.budget?.maxTimeMs,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      // Send prompt via stdin
      child.stdin?.write(context.prompt);
      child.stdin?.end();

      const abortHandler = () => {
        child.kill('SIGTERM');
      };
      context.abortSignal?.addEventListener('abort', abortHandler);

      child.on('close', (code) => {
        context.abortSignal?.removeEventListener('abort', abortHandler);
        const durationMs = Date.now() - startTime;
        resolve({
          success: code === 0,
          output: stdout,
          error: code !== 0 ? `Process exited with code ${code}. ${stderr}`.trim() : undefined,
          durationMs,
          turnsUsed: 1,
          data: { exitCode: code, stderr },
        });
      });

      child.on('error', (err) => {
        context.abortSignal?.removeEventListener('abort', abortHandler);
        const durationMs = Date.now() - startTime;
        resolve({
          success: false,
          output: stdout,
          error: err.message,
          durationMs,
          turnsUsed: 0,
        });
      });
    });
  }

  async diagnostics(): Promise<AdapterDiagnostics> {
    return { available: true, reason: 'Shell process adapter is always available' };
  }
}

// ─── HTTP Webhook Adapter ───────────────────────────────────────────

export class HttpWebhookAdapter implements Adapter {
  readonly type = 'http-webhook' as const;
  readonly label = 'HTTP Webhook';

  async execute(context: RunContext): Promise<RunResult> {
    const url = context.env?.url as string;
    if (!url) {
      return {
        success: false,
        output: '',
        error: 'No URL specified in env.url',
        durationMs: 0,
        turnsUsed: 0,
      };
    }

    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: context.prompt,
          agentId: context.agentId,
          companyId: context.companyId,
          tools: context.tools?.map((t) => t.name),
          budget: context.budget,
        }),
        signal: context.abortSignal,
      });

      const durationMs = Date.now() - startTime;
      const body = await response.text();

      if (!response.ok) {
        return {
          success: false,
          output: body,
          error: `HTTP ${response.status}: ${response.statusText}`,
          durationMs,
          turnsUsed: 0,
        };
      }

      // Try to parse as JSON for structured results
      try {
        const parsed = JSON.parse(body);
        return {
          success: parsed.success ?? true,
          output: parsed.output ?? body,
          error: parsed.error,
          durationMs,
          turnsUsed: parsed.turnsUsed ?? 1,
          tokens: parsed.tokens,
          costUsd: parsed.costUsd,
          sessionState: parsed.sessionState,
          data: parsed.data,
        };
      } catch {
        // Plain text response
        return {
          success: true,
          output: body,
          durationMs,
          turnsUsed: 1,
        };
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs,
        turnsUsed: 0,
      };
    }
  }

  async diagnostics(): Promise<AdapterDiagnostics> {
    // HTTP adapters are only available if a URL is configured
    return { available: true, reason: 'HTTP webhook adapter requires URL in run context' };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Create and register the default set of adapters based on available runtimes.
 */
export function createDefaultAdapters(deps: {
  getClient: () => IChatClient | null;
  getTools: () => Tool[];
  projectDir: string;
}): void {
  // Ollama local adapter
  registerAdapter(
    { id: 'ollama-local', type: 'ollama-local', name: 'Ollama Local', settings: {}, enabled: true },
    new OllamaLocalAdapter(deps),
  );

  // Process adapter
  registerAdapter(
    { id: 'process', type: 'process', name: 'Shell Process', settings: {}, enabled: true },
    new ProcessAdapter({ projectDir: deps.projectDir }),
  );

  // HTTP webhook adapter
  registerAdapter(
    { id: 'http-webhook', type: 'http-webhook', name: 'HTTP Webhook', settings: {}, enabled: true },
    new HttpWebhookAdapter(),
  );
}