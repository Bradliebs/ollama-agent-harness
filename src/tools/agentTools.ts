// create_custom_agent — let the running agent define new specialised
// sub-agents from observed patterns. Stored as `.harness/agents/<id>.md`.

import type { Tool, ToolResult } from '../types';
import { writeCustomAgent } from '../agents/agentLoader';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export const CreateCustomAgentTool: Tool = {
  name: 'create_custom_agent',
  description: 'Define a new sub-agent and persist it under .harness/agents/. Future calls can route to this agent by id.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable id (alphanumeric, dashes, underscores)' },
      name: { type: 'string', description: 'Display name' },
      description: { type: 'string', description: 'One-line summary of what this agent does' },
      role: { type: 'string', description: 'Optional role label (e.g. researcher, developer, qa)' },
      preset: { type: 'string', description: 'Optional helper preset: explore, plan, search, general, verify, summarize' },
      model: { type: 'string', description: 'Optional preferred model id' },
      personality: { type: 'string' },
      goal: { type: 'string' },
      system_prompt: { type: 'string', description: 'The system prompt that defines this agent' },
      allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool name allowlist' },
    },
    required: ['id', 'name', 'description', 'system_prompt'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = asString(input.id);
    const name = asString(input.name);
    const description = asString(input.description);
    const systemPrompt = asString(input.system_prompt);
    if (!id || !name || !description || !systemPrompt) {
      const missing = ['id', 'name', 'description', 'system_prompt'].filter((k) => !asString((input as Record<string, unknown>)[k as keyof typeof input]));
      const message = `Missing required fields: ${missing.join(', ')}`;
      return { success: false, output: message, error: message };
    }
    try {
      const filePath = await writeCustomAgent(process.cwd(), {
        id,
        name,
        description,
        role: asString(input.role),
        model: asString(input.model),
        preset: asString(input.preset) as never,
        personality: asString(input.personality),
        goal: asString(input.goal),
        systemPrompt,
        allowedTools: asStringArray(input.allowed_tools),
      });
      return { success: true, output: `Saved agent "${id}" to ${filePath}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message, error: message };
    }
  },
};
