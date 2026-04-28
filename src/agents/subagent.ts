import type { Tool, ToolResult } from '../types';
import { OllamaClient } from '../core/ollamaClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';

export interface SubagentConfig {
  name: string;
  systemPrompt: string;
  model?: string;
  tools?: Tool[];
  maxTurns?: number;
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
  parentClient: OllamaClient,
  availableTools: Tool[],
): Promise<string> {
  // Create isolated client (may use different model)
  const client = config.model
    ? new OllamaClient({ model: config.model })
    : parentClient;

  // Determine tool set for the subagent
  const subagentTools = config.tools ?? filterToolsForSubagent(availableTools, config.name);

  const deps: QueryLoopDeps = {
    client,
    tools: subagentTools,
  };

  const loopConfig = {
    model: client.getModel(),
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns ?? 10,
  };

  // Run the subagent loop in an isolated context
  const messages = [{ role: 'user' as const, content: prompt }];
  let lastText = '';

  for await (const event of queryLoop(loopConfig, deps, messages)) {
    if (event.type === 'text') {
      lastText = event.content;
    }
  }

  // Return only the summary text — never the full conversation history
  return lastText || '(subagent produced no output)';
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
