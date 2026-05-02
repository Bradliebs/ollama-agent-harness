import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { OllamaClient } from '../core/ollamaClient';
import type { IChatClient } from '../core/chatClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { createHelperAgentConfig, type HelperTaskType, type ModelRoutingDecision, type ModelRoutingInput, type ModelRoutingPolicy } from './modelRouting';

export interface SubagentConfig {
  name: string;
  systemPrompt: string;
  model?: string;
  tools?: Tool[];
  maxTurns?: number;
  preset?: HelperTaskType;
  routingPolicy?: ModelRoutingPolicy;
  routingInput?: Partial<ModelRoutingInput>;
  routingDecision?: ModelRoutingDecision;
  metricsProjectDir?: string;
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
      output: 'AgentTool.execute should not be called directly — use runSubagent()',
      error: 'Direct execution not supported',
    };
  },
};

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
  const subagentTools = effectiveConfig.tools ?? filterToolsForSubagent(availableTools, effectiveConfig.name);

  const deps: QueryLoopDeps = {
    client,
    tools: subagentTools,
  };

  const loopConfig = {
    model: client.getModel(),
    systemPrompt: effectiveConfig.systemPrompt,
    maxTurns: effectiveConfig.maxTurns ?? 10,
  };

  // Run the subagent loop in an isolated context
  const messages = [{ role: 'user' as const, content: prompt }];
  let lastText = '';

  try {
    for await (const event of queryLoop(loopConfig, deps, messages)) {
      if (event.type === 'text') {
        lastText = event.content;
      }
    }
    success = lastText.length > 0;
  } finally {
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

  // Return only the summary text — never the full conversation history
  return lastText || '(subagent produced no output)';
}

export function resolveSubagentConfig(config: SubagentConfig, prompt: string): SubagentConfig {
  if (!config.preset) {
    return config;
  }

  const helper = createHelperAgentConfig({
    taskType: config.preset,
    prompt,
    ...config.routingInput,
  }, config.routingPolicy);

  return {
    ...config,
    name: config.name || helper.name,
    systemPrompt: config.systemPrompt || helper.systemPrompt,
    model: config.model ?? helper.model,
    maxTurns: config.maxTurns ?? helper.maxTurns,
    routingDecision: helper.routing,
  };
}

export async function appendSubagentRoutingMetric(
  projectDir: string,
  metric: SubagentRoutingMetric,
): Promise<string> {
  const filePath = path.join(projectDir, '.harness', 'learning', 'subagent-routing.jsonl');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(metric) + '\n', 'utf-8');
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
