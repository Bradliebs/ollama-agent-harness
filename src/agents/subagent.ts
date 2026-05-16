import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { OllamaClient } from '../core/ollamaClient';
import type { IChatClient } from '../core/chatClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { withFileLock } from '../persistence/atomicFile';
import { createHelperAgentConfig, type HelperTaskType, type ModelRoutingDecision, type ModelRoutingInput, type ModelRoutingPolicy } from './modelRouting';
import { resolveAgentDefinition, type AgentDefinition } from './agentLoader';
import { registerSubagent, unregisterSubagent } from '../services/subagentRegistry';
import { recordSwallowed } from '../observability/silentFailureSink';

export interface SubagentConfig {
  name: string;
  systemPrompt: string;
  model?: string;
  tools?: Tool[];
  /** When set, only tools whose name appears in this list are visible. Applied after `tools` is resolved. */
  allowedTools?: string[];
  maxTurns?: number;
  preset?: HelperTaskType;
  routingPolicy?: ModelRoutingPolicy;
  routingInput?: Partial<ModelRoutingInput>;
  routingDecision?: ModelRoutingDecision;
  metricsProjectDir?: string;
  /** When set, resolves a built-in or custom agent definition and uses it as defaults. Explicit fields on this config still override the definition. */
  agentId?: string;
  /** Caller-provided custom agent definitions. Built-ins are consulted as a fallback. */
  customAgents?: AgentDefinition[];
  /** When set, the run is registered in the active sub-agent registry under this id so the UI bar and cancel endpoint can see it. */
  runId?: string;
  /** Optional abort signal piped into the inner queryLoop. Used by the cancel endpoint together with runId. */
  abortSignal?: AbortSignal;
  /** Optional listener invoked for every loop event. Useful for surfacing live progress to a parent UI. */
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}

export interface SubagentRoutingMetric {
  timestamp: string;
  name: string;
  preset?: HelperTaskType;
  model?: string;
  tier?: string;
  escalated?: boolean;
  reasons: string[];
  success: boolean;
  durationMs: number;
  outputChars: number;
}

export const AgentTool: Tool = {
  name: 'agent',
  description: 'Delegate a task to a subagent that runs in an isolated context. Returns only the summary, not the full conversation.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The task prompt for the subagent' },
      type: { type: 'string', description: 'Subagent type: explore (read-only), plan (creates plan), general (full capabilities)' },
    },
    required: ['prompt'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    return {
      success: false,
      output: 'AgentTool.execute should not be called directly — use createSubagentTool() to bind a client and tool list.',
      error: 'Direct execution not supported',
    };
  },
};

/**
 * Build a callable subagent tool bound to a parent chat client, the available
 * tool list, and an accessor that returns the current set of custom agent
 * definitions. The returned tool can be registered like any other tool and
 * the model can call it with `prompt` and either `agent_id` (preferred) or
 * legacy `type`.
 */
export interface SubagentToolDeps {
  getParentClient(): IChatClient;
  getAvailableTools(): Tool[];
  getCustomAgents?: () => AgentDefinition[];
  /** Optional override of runSubagent — primarily for tests. */
  runner?: typeof runSubagent;
  /**
   * Optional recall provider. When set, the subagent receives a Knowledge
   * Graph recall block prepended to its prompt so it shares the same
   * project memory as the parent chat.
   */
  getRecallContext?: (prompt: string) => Promise<string | undefined>;
}

export function createSubagentTool(deps: SubagentToolDeps): Tool {
  const runner = deps.runner ?? runSubagent;
  return {
    name: 'agent',
    description: 'Delegate a task to a sub-agent that runs in an isolated context. Pass agent_id (e.g. researcher, developer, qa, writer, architect, security, or any custom agent under .harness/agents/) to choose a role. Returns only the summary, not the full conversation.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task prompt for the sub-agent' },
        agent_id: { type: 'string', description: 'Built-in role id or custom agent id from .harness/agents/' },
        type: { type: 'string', description: 'Legacy subagent type alias: explore, plan, general' },
      },
      required: ['prompt'],
    },
    isReadOnly: false,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) {
        return { success: false, output: 'prompt is required', error: 'prompt is required' };
      }
      const agentId = typeof input.agent_id === 'string' && input.agent_id.trim() ? input.agent_id.trim() : undefined;
      const legacyType = typeof input.type === 'string' && input.type.trim() ? input.type.trim() : undefined;
      const customAgents = deps.getCustomAgents ? deps.getCustomAgents() : [];
      // When agent_id resolves to nothing and legacy type is provided, fall
      // back to the original behaviour where `name` selected the tool filter.
      // Generate a runId so the run is visible in /api/subagents and the
      // active sub-agents UI bar.
      const runId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const config: SubagentConfig = {
        name: agentId ?? legacyType ?? 'general',
        systemPrompt: '',
        agentId,
        customAgents,
        runId,
      };
      try {
        let effectivePrompt = prompt;
        if (deps.getRecallContext) {
          try {
            const recall = await deps.getRecallContext(prompt);
            if (recall && recall.trim().length > 0) {
              effectivePrompt = `${recall}\n\n${prompt}`;
            }
          } catch (err) { recordSwallowed('subagent.getRecallContext', err); }
        }
        const summary = await runner(config, effectivePrompt, deps.getParentClient(), deps.getAvailableTools());
        return { success: true, output: summary };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: `Subagent failed: ${message}`, error: message };
      }
    },
  };
}

export async function runSubagent(
  config: SubagentConfig,
  prompt: string,
  parentClient: IChatClient,
  availableTools: Tool[],
): Promise<string> {
  const effectiveConfig = resolveSubagentConfig(config, prompt);
  const started = Date.now();
  let success = false;

  // Create isolated client (may use different model)
  const client = effectiveConfig.model
    ? new OllamaClient({ model: effectiveConfig.model })
    : parentClient;

  // Determine tool set for the subagent
  let subagentTools = effectiveConfig.tools ?? filterToolsForSubagent(availableTools, effectiveConfig.name);
  if (effectiveConfig.allowedTools && effectiveConfig.allowedTools.length > 0) {
    const allow = new Set(effectiveConfig.allowedTools);
    subagentTools = subagentTools.filter((tool) => allow.has(tool.name));
  }

  const deps: QueryLoopDeps = {
    client,
    tools: subagentTools,
  };

  // Build the abort controller used by the cancel endpoint. If the caller
  // supplied a signal, link them so either source can abort the run.
  const internalController = new AbortController();
  const externalSignal = effectiveConfig.abortSignal;
  const onExternalAbort = () => internalController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) internalController.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const loopConfig = {
    model: client.getModel(),
    systemPrompt: effectiveConfig.systemPrompt,
    maxTurns: effectiveConfig.maxTurns ?? 10,
    abortSignal: internalController.signal,
  };

  const runId = effectiveConfig.runId;
  if (runId) {
    registerSubagent({ id: runId, name: effectiveConfig.name || 'subagent', prompt, controller: internalController, startedAtMs: started });
  }

  // Run the subagent loop in an isolated context
  const messages = [{ role: 'user' as const, content: prompt }];
  let lastText = '';
  let cancelled = false;

  try {
    for await (const event of queryLoop(loopConfig, deps, messages)) {
      if (effectiveConfig.onEvent) {
        try { effectiveConfig.onEvent(event as unknown as { type: string; [key: string]: unknown }); } catch { /* listener errors are non-fatal */ }
      }
      if (event.type === 'text') {
        lastText = event.content;
      }
    }
    success = lastText.length > 0;
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError' || internalController.signal.aborted) {
      cancelled = true;
    } else {
      throw error;
    }
  } finally {
    if (externalSignal) {
      try { externalSignal.removeEventListener('abort', onExternalAbort); } catch { /* best-effort */ }
    }
    if (runId) unregisterSubagent(runId);
    await appendSubagentRoutingMetric(effectiveConfig.metricsProjectDir ?? process.cwd(), {
      timestamp: new Date().toISOString(),
      name: effectiveConfig.name,
      preset: effectiveConfig.preset,
      model: effectiveConfig.model ?? client.getModel(),
      tier: effectiveConfig.routingDecision?.tier,
      escalated: effectiveConfig.routingDecision?.escalated,
      reasons: effectiveConfig.routingDecision?.reasons ?? [],
      success,
      durationMs: Date.now() - started,
      outputChars: lastText.length,
    }).catch(() => {});
  }

  if (cancelled && !lastText) {
    return '(subagent cancelled)';
  }
  // Return only the summary text — never the full conversation history
  return lastText || '(subagent produced no output)';
}

export function resolveSubagentConfig(config: SubagentConfig, prompt: string): SubagentConfig {
  // Step 1: apply built-in or custom agent definition (when agentId is set).
  let working = config;
  if (config.agentId) {
    const definition = resolveAgentDefinition(config.agentId, config.customAgents ?? []);
    if (definition) {
      working = {
        ...config,
        name: config.name || definition.name || definition.id,
        systemPrompt: config.systemPrompt || definition.systemPrompt,
        model: config.model ?? definition.model,
        maxTurns: config.maxTurns ?? definition.maxTurns,
        preset: config.preset ?? definition.preset,
        allowedTools: config.allowedTools ?? definition.allowedTools,
      };
    }
  }

  // Step 2: apply preset routing if a preset is set.
  if (!working.preset) {
    return working;
  }

  const helper = createHelperAgentConfig({
    taskType: working.preset,
    prompt,
    ...working.routingInput,
  }, working.routingPolicy);

  return {
    ...working,
    name: working.name || helper.name,
    systemPrompt: working.systemPrompt || helper.systemPrompt,
    model: working.model ?? helper.model,
    maxTurns: working.maxTurns ?? helper.maxTurns,
    routingDecision: helper.routing,
  };
}

export async function appendSubagentRoutingMetric(
  projectDir: string,
  metric: SubagentRoutingMetric,
): Promise<string> {
  const filePath = path.join(projectDir, '.harness', 'learning', 'subagent-routing.jsonl');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await withFileLock(filePath, () => fs.appendFile(filePath, JSON.stringify(metric) + '\n', 'utf-8'));
  return filePath;
}

export async function listSubagentRoutingMetrics(projectDir: string, limit = 20): Promise<SubagentRoutingMetric[]> {
  const filePath = path.join(projectDir, '.harness', 'learning', 'subagent-routing.jsonl');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SubagentRoutingMetric)
      .slice(-limit);
  } catch {
    return [];
  }
}

function filterToolsForSubagent(tools: Tool[], subagentType: string): Tool[] {
  switch (subagentType) {
    case 'explore':
      // Read-only tools only
      return tools.filter((t) => t.isReadOnly);
    case 'plan':
      // Read-only + file write for plan output
      return tools.filter((t) => t.isReadOnly || t.name === 'file_write');
    default:
      // General: all tools except the agent tool itself (prevent recursion bombs)
      return tools.filter((t) => t.name !== 'agent');
  }
}
