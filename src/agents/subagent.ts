import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { OllamaClient } from '../core/ollamaClient';
import type { IChatClient } from '../core/chatClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { withFileLock } from '../persistence/atomicFile';
import { revertRun } from '../persistence/runReverter';
import { createHelperAgentConfig, type HelperTaskType, type ModelRoutingDecision, type ModelRoutingInput, type ModelRoutingPolicy } from './modelRouting';
import { resolveAgentDefinition, type AgentDefinition, type SubAgentRef } from './agentLoader';
import { requireAgentDefinition } from './agentId';
import { registerSubagent, unregisterSubagent, updateSubagentActivity, getActiveSubagent } from '../services/subagentRegistry';
import { appendSubagentRun } from '../services/subagentRuns';
import { recordSwallowed } from '../observability/silentFailureSink';
import { renderTemplate } from '../prompts/template';

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
  /**
   * Opt-in side-effect recovery. When set (and `runId` is present), the
   * subagent's file mutations are recorded under its own `runId` and reverted
   * if the run ends in error — a thrown error, or a queryLoop `done` event with
   * reason `error`. User cancellation and soft no-output runs are NOT reverted.
   * Omitted by default, so existing callers and tests are unaffected.
   */
  undoOnError?: { projectDir: string };
  /** Optional listener invoked for every loop event. Useful for surfacing live progress to a parent UI. */
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
  /**
   * Chain of agent ids from the root caller to (but excluding) this run, used
   * by declarative sub-agent tools for cycle detection and depth limiting.
   * The runtime appends the current agent's id to this list when it builds
   * sub-agent tools for its own declared `subAgents` surface.
   */
  parentChain?: string[];
  /** Maximum sub-agent invocation depth before the chain is rejected. Default 5. */
  maxDepth?: number;
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

  // Append declared sub-agent tools so this agent can delegate to its own
  // declarative `subAgents` surface. Cycle/depth checks fire at invocation
  // time. The parentChain we pass downward includes this agent's id.
  if (effectiveConfig.agentId) {
    const definition = resolveAgentDefinition(effectiveConfig.agentId, effectiveConfig.customAgents ?? []);
    if (definition?.subAgents && definition.subAgents.length > 0) {
      const myChain = [...(effectiveConfig.parentChain ?? []), effectiveConfig.agentId];
      const subTools = createSubAgentToolsFromDefinition(definition, {
        getParentClient: () => parentClient,
        getAvailableTools: () => availableTools,
        getCustomAgents: () => effectiveConfig.customAgents ?? [],
        parentChain: myChain,
        maxDepth: effectiveConfig.maxDepth,
      });
      subagentTools = [...subagentTools, ...subTools];
    }
  }

  const deps: QueryLoopDeps = {
    client,
    tools: subagentTools,
    ...(effectiveConfig.undoOnError && effectiveConfig.runId
      ? { sideEffectRecorder: { projectDir: effectiveConfig.undoOnError.projectDir, runId: effectiveConfig.runId } }
      : {}),
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
  let runError: Error | null = null;
  let erroredOut = false;

  try {
    for await (const event of queryLoop(loopConfig, deps, messages)) {
      if (effectiveConfig.onEvent) {
        try { effectiveConfig.onEvent(event as unknown as { type: string; [key: string]: unknown }); } catch { /* listener errors are non-fatal */ }
      }
      // Surface live activity to the sub-agents bar. Best-effort — no-op
      // when the run has no runId (registry never registered it).
      if (runId) {
        const ev = event as { type?: string; call?: { name?: string }; content?: string };
        if (ev.type === 'tool_call' && ev.call && ev.call.name) {
          updateSubagentActivity(runId, '\uD83D\uDD27 ' + String(ev.call.name));
        } else if (ev.type === 'synthesis_fired') {
          updateSubagentActivity(runId, 'finalising\u2026');
        } else if (ev.type === 'text' && typeof ev.content === 'string' && ev.content.trim()) {
          updateSubagentActivity(runId, '\u270D writing reply');
        }
      }
      if (event.type === 'text') {
        lastText = event.content;
      }
      if (event.type === 'done' && (event as { reason?: string }).reason === 'error') {
        erroredOut = true;
      }
    }
    success = lastText.length > 0;
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError' || internalController.signal.aborted) {
      cancelled = true;
    } else {
      runError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  } finally {
    if (externalSignal) {
      try { externalSignal.removeEventListener('abort', onExternalAbort); } catch { /* best-effort */ }
    }
    // Opt-in recovery: if recording was enabled and the run ended in error
    // (thrown error, or a loop `done` event with reason `error`), revert the
    // subagent's file mutations so a failed delegation leaves no half-applied
    // changes behind. Best-effort — the run already happened. Cancellation and
    // soft no-output runs are intentionally left untouched.
    if (effectiveConfig.undoOnError && effectiveConfig.runId && (runError || erroredOut)) {
      try {
        await revertRun(effectiveConfig.undoOnError.projectDir, effectiveConfig.runId);
      } catch (err) { recordSwallowed('subagent.undoOnError', err); }
    }
    // Snapshot the tool history from the registry BEFORE we unregister so
    // it can be persisted into the run record. Without this, the "what did
    // this agent actually do?" answer is lost the moment the run ends.
    const activeRecord = runId ? getActiveSubagent(runId) : undefined;
    const toolHistory = activeRecord?.activityHistory?.map((entry) => entry.label) ?? [];
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
    // Persistent run record so the Agents tab can show a history view
    // and the user can answer "what has this agent done lately?" without
    // grepping session events.
    const projectDir = effectiveConfig.metricsProjectDir
      ?? process.env.HARNESS_PROJECT_DIR
      ?? process.cwd();
    const now = Date.now();
    await appendSubagentRun(projectDir, {
      runId: runId ?? `subagent-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: effectiveConfig.name || 'subagent',
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationMs: now - started,
      status: cancelled ? 'cancelled' : runError ? 'failed' : 'completed',
      prompt: prompt.slice(0, 500),
      output: (lastText || '').slice(0, 2000),
      toolHistory: toolHistory.slice(-50),
      model: effectiveConfig.model ?? client.getModel(),
      outputDir: process.env.HARNESS_AGENT_OUTPUT_DIR || undefined,
      error: runError ? runError.message : undefined,
    }).catch(() => { /* best-effort — the run already happened */ });
  }

  if (cancelled && !lastText) {
    return '(subagent cancelled)';
  }
  // Return only the summary text — never the full conversation history
  return lastText || '(subagent produced no output)';
}

export function resolveSubagentConfig(config: SubagentConfig, prompt: string): SubagentConfig {
  // Step 1: apply built-in or custom agent definition (when agentId is set).
  // Strict: an explicit agentId that resolves to nothing throws — silently
  // running with no role/defaults is the bug Tier 3 #2 is closing.
  let working = config;
  if (config.agentId) {
    const definition = requireAgentDefinition(config.agentId, config.customAgents ?? []);
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

/** Default maximum sub-agent chain depth (root → child → grandchild → …). */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 5;

export interface SubAgentToolFactoryDeps {
  getParentClient(): IChatClient;
  getAvailableTools(): Tool[];
  getCustomAgents?: () => AgentDefinition[];
  /** Chain of agent ids leading up to (but not including) the parent of these tools. */
  parentChain: string[];
  maxDepth?: number;
  /** Optional override of runSubagent — primarily for tests. */
  runner?: typeof runSubagent;
}

/**
 * Build per-sub-agent Tool entries from a parent AgentDefinition's declarative
 * `subAgents` field. Each returned tool is named `subagent_<ref.name>`, calls
 * `runSubagent` with the bound `agentId`, and substitutes the ref's `values`
 * into the LLM-supplied prompt via `{{key}}` placeholders (extra values are
 * surfaced as a Context block so the child can use them either way).
 *
 * Cycle and depth checks run at tool invocation time, not at factory time,
 * because the factory may build tools that are never actually called.
 */
export function createSubAgentToolsFromDefinition(
  definition: AgentDefinition,
  deps: SubAgentToolFactoryDeps,
): Tool[] {
  if (!definition.subAgents || definition.subAgents.length === 0) return [];
  const runner = deps.runner ?? runSubagent;
  const maxDepth = deps.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
  return definition.subAgents.map((ref) => buildSubAgentTool(ref, definition, deps, runner, maxDepth));
}

function buildSubAgentTool(
  ref: SubAgentRef,
  parent: AgentDefinition,
  deps: SubAgentToolFactoryDeps,
  runner: typeof runSubagent,
  maxDepth: number,
): Tool {
  const valueSummary = ref.values && Object.keys(ref.values).length > 0
    ? ` Pre-bound values: ${Object.keys(ref.values).join(', ')}.`
    : '';
  const description = (ref.description ? `${ref.description}. ` : '')
    + `Delegate to sub-agent "${ref.name}" (agent_id: ${ref.agentId}).${valueSummary}`;
  return {
    name: `subagent_${ref.name}`,
    description,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: `The task prompt for sub-agent "${ref.name}". Pre-bound values can be referenced via {{key}} placeholders.` },
      },
      required: ['prompt'],
    },
    isReadOnly: false,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const promptRaw = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!promptRaw) {
        return { success: false, output: 'prompt is required', error: 'prompt is required' };
      }
      // Cycle and depth checks against the chain leading to this tool.
      const projectedChain = [...deps.parentChain, ref.agentId];
      if (projectedChain.length > maxDepth) {
        const message = `Sub-agent depth limit exceeded (${projectedChain.length} > ${maxDepth}): ${projectedChain.join(' -> ')}`;
        return { success: false, output: message, error: message };
      }
      if (deps.parentChain.includes(ref.agentId)) {
        const message = `Sub-agent cycle detected: ${projectedChain.join(' -> ')}`;
        return { success: false, output: message, error: message };
      }
      const effectivePrompt = renderSubAgentPrompt(promptRaw, ref.values);
      const runId = `subagent-${ref.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const config: SubagentConfig = {
        name: `${parent.id}:${ref.name}`,
        systemPrompt: '',
        agentId: ref.agentId,
        customAgents: deps.getCustomAgents ? deps.getCustomAgents() : [],
        runId,
        parentChain: projectedChain,
        maxDepth,
      };
      try {
        const summary = await runner(config, effectivePrompt, deps.getParentClient(), deps.getAvailableTools());
        return { success: true, output: summary };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: `Sub-agent "${ref.name}" failed: ${message}`, error: message };
      }
    },
  };
}

/**
 * Substitute `{{key}}` placeholders in `prompt` with the supplied `values`,
 * then prepend a Context block listing the bindings so the child agent sees
 * them whether or not the prompt referenced them. Returns the prompt
 * unchanged when no values are bound.
 *
 * Variable substitution is delegated to the shared prompt template engine
 * (../prompts/template) so prompts can also use {{#if key}} / {{#unless key}}
 * blocks if they want to conditionalise sections on the presence of a bound
 * value. Unbound `{{key}}` placeholders are left in place (more debuggable
 * than a silent drop).
 */
export function renderSubAgentPrompt(prompt: string, values?: Record<string, string>): string {
  if (!values || Object.keys(values).length === 0) return prompt;
  const substituted = renderTemplate(prompt, values);
  const contextLines = Object.entries(values).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `Context (pre-bound by parent):\n${contextLines}\n\n${substituted}`;
}

